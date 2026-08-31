import type { ServerWebSocket } from "bun";
import { decryptJson, encryptJson, parseEdxAmount, validateAddress } from "@edgex/shared";
import type { WalletConfig } from "../config/config";
import type { CommKey } from "../keys/commKey";
import type { WalletCore } from "../core/walletCore";
import type { Logger } from "../utils/log";
import { GameStore } from "./gameStore";

/**
 * Game config mirror (the old centralized build served it via the backend /api/game/info; the
 * decentralized build parses it locally from dexcoin.conf and keeps the old DTO field layout so the
 * game page cannot tell the difference). cycleStart/cycleEnd/nextSettle are derived from gamesettlehourutc.
 */
export interface GameInfo {
  fee: string;
  feeAddress: string;
  minScore: number;
  rewards: string[];
  settleHourUtc: number;
  cycleStart: string;
  cycleEnd: string;
  nextSettle: string;
  maxSize: number;
  maxFreq: number;
}

/** Max messages per connection per minute (protects the local port from message floods). */
const MAX_MSG_PER_MINUTE = 180;
/** Leaderboard result row cap. */
const LEADERBOARD_LIMIT = 50;

export interface GameGateOptions {
  config: WalletConfig;
  core: WalletCore;
  commKey?: CommKey;
  /** Wallet password (held in memory after TUI unlock / daemon's EDX_WALLET_PASSWORD); uploads are rejected when missing, read-only queries still work. */
  password?: string;
  log: Logger;
}

/** WS connection metadata: Origin recorded at handshake + hello pairing result. */
interface SocketData {
  origin: string;
  authed: boolean;
  hits: number[];
}

function reply(ws: ServerWebSocket<SocketData>, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Derives the current settlement cycle window from the daily settlement hour (UTC). */
function settleCycle(
  settleHourUtc: number,
  nowMs: number,
): { cycleStart: string; cycleEnd: string; nextSettle: string } {
  const anchor = new Date(nowMs);
  anchor.setUTCHours(settleHourUtc, 0, 0, 0);
  let cycleStart = new Date(anchor);
  if (cycleStart.getTime() > nowMs) cycleStart = new Date(cycleStart.getTime() - 86_400_000);
  const cycleEnd = new Date(cycleStart.getTime() + 86_400_000);
  return {
    cycleStart: cycleStart.toISOString(),
    cycleEnd: cycleEnd.toISOString(),
    nextSettle: cycleEnd.toISOString(),
  };
}

function buildGameInfo(config: WalletConfig): GameInfo {
  const { cycleStart, cycleEnd, nextSettle } = settleCycle(config.gameSettleHourUtc, Date.now());
  return {
    fee: config.gameFee,
    feeAddress: config.gameFeeAddress,
    minScore: config.gameMinScore,
    rewards: config.gameRewards,
    settleHourUtc: config.gameSettleHourUtc,
    cycleStart,
    cycleEnd,
    nextSettle,
    maxSize: config.gameMaxSize,
    maxFreq: config.gameMaxFreq,
  };
}

/**
 * Local game gateway: game page (public domain) → ws://127.0.0.1:gameport → this wallet.
 * - Listens on 127.0.0.1 only; the handshake validates Origin against the gameorigins whitelist in dexcoin.conf (`*` allows all, recommended for local debugging only);
 * - hello validates the pairing token (gamepairtoken, optional) and records it as session authorization; connections that never hello cannot do anything;
 * - upload has the wallet auto-sign a tip transaction (amount = gamefee, clamped by the gamefee / gamefeeperday caps) and broadcasts it on-chain directly;
 *   the record lands in the wallet's local ledger (game.db), uploadId is idempotent and retries never double-charge;
 * - save reads (save:get) are decrypted with the wallet comm private key; plaintext only ever goes back to the game page over localhost;
 * - when the wallet is locked (auth:change=false) all connections are dropped and the game cannot continue.
 */
export class GameGate {
  private server: ReturnType<typeof Bun.serve<SocketData>> | null = null;
  private sockets = new Set<ServerWebSocket<SocketData>>();
  private readonly store: GameStore;
  /** Cumulative tips charged today (sat, in-memory counter, resets on restart). */
  private dailyFeeSat = 0n;
  private dailyKey = "";
  /** Session lock flag: set by auth:change(false) which also drops all connections; cleared by a successful password check (auth:change(true)). */
  private locked = false;
  private readonly unsub: () => void;

  constructor(private readonly opts: GameGateOptions) {
    this.store = new GameStore(opts.config.datadir);
    this.unsub = opts.core.bus.on("auth:change", (unlocked) => {
      this.locked = !unlocked;
      if (!unlocked) {
        for (const ws of this.sockets) ws.close(4001, "wallet locked");
        this.sockets.clear();
      }
    });
  }

  start(): void {
    if (this.server) return;
    const port = this.opts.config.gamePort;
    if (port === undefined || port <= 0) return;
    if (this.opts.config.gameOrigins.length === 0) {
      this.opts.log.warn("'gameorigins' not configured in dexcoin.conf; all game connections will be refused");
    }
    this.server = Bun.serve<SocketData>({
      port,
      hostname: "127.0.0.1",
      fetch: (req, server) => {
        const origin = req.headers.get("origin") ?? "";
        if (!this.originAllowed(origin)) return new Response("forbidden", { status: 403 });
        // After a successful handshake Bun takes over the connection (official example convention: return undefined here)
        if (server.upgrade(req, { data: { origin, authed: false, hits: [] } })) return undefined;
        return new Response("bad request", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
        },
        message: (ws, message) => {
          void this.onMessage(ws, String(message));
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
      },
    });
    const origins = this.opts.config.gameOrigins.includes("*")
      ? "*"
      : this.opts.config.gameOrigins.join(",") || "(none)";
    this.opts.log.info(
      this.opts.config.gamePairToken === ""
        ? `Game gateway listening on ws://127.0.0.1:${port} (origins: ${origins})`
        : `Game gateway listening on ws://127.0.0.1:${port} (origins: ${origins}, token required)`,
    );
  }

  stop(): void {
    this.unsub();
    this.server?.stop(true);
    this.server = null;
    this.sockets.clear();
    this.store.close();
  }

  private originAllowed(origin: string): boolean {
    const whitelist = this.opts.config.gameOrigins;
    if (whitelist.includes("*")) return true;
    return whitelist.includes(origin);
  }

  private rateLimited(ws: ServerWebSocket<SocketData>): boolean {
    const now = Date.now();
    const hits = ws.data.hits;
    hits.push(now);
    while (hits.length > 0 && now - hits[0] > 60_000) hits.shift();
    return hits.length > MAX_MSG_PER_MINUTE;
  }

  private async onMessage(ws: ServerWebSocket<SocketData>, raw: string): Promise<void> {
    if (this.rateLimited(ws)) {
      reply(ws, { type: "error", ok: false, error: "message rate limit exceeded" });
      ws.close(4008, "rate limited");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      reply(ws, { type: "error", ok: false, error: "invalid JSON" });
      return;
    }
    if (typeof msg !== "object" || msg === null) {
      reply(ws, { type: "error", ok: false, error: "invalid message" });
      return;
    }
    const type = typeof msg.type === "string" ? msg.type : "";
    const seq = typeof msg.seq === "number" ? msg.seq : undefined;
    // Everything but hello requires completed pairing authorization
    if (type !== "hello" && !ws.data.authed) {
      reply(ws, { type: "error", seq, ok: false, error: "not authorized: send hello with the pairing token first" });
      ws.close(4003, "not authorized");
      return;
    }
    try {
      switch (type) {
        case "hello":
          await this.handleHello(ws, msg, seq);
          break;
        case "info":
          this.handleInfo(ws, seq);
          break;
        case "leaderboard":
          await this.handleLeaderboard(ws, msg, seq);
          break;
        case "upload":
          await this.handleUpload(ws, msg, seq);
          break;
        case "save:get":
          this.handleSaveGet(ws, msg, seq);
          break;
        case "rewards":
          this.handleRewards(ws, seq);
          break;
        default:
          reply(ws, { type: "error", seq, ok: false, error: `unknown message type: ${type}` });
      }
    } catch (error) {
      const message = errorMessage(error);
      this.opts.log.warn(`Game gateway ${type} failed: ${message}`);
      reply(ws, { type: "error", seq, ok: false, error: message });
    }
  }

  private async handleHello(ws: ServerWebSocket<SocketData>, msg: Record<string, unknown>, seq?: number): Promise<void> {
    const token = this.opts.config.gamePairToken;
    if (token !== "" && msg.token !== token) {
      reply(ws, { type: "hello", seq, ok: false, error: "invalid pairing token" });
      ws.close(4003, "invalid pairing token");
      return;
    }
    ws.data.authed = true;
    reply(ws, {
      type: "hello",
      seq,
      ok: true,
      unlocked: !this.locked,
      address: this.opts.core.getAddress(),
      commKey: this.opts.commKey?.publicKeyHex ?? "",
      game: this.getInfo(),
    });
  }

  private handleInfo(ws: ServerWebSocket<SocketData>, seq?: number): void {
    reply(ws, { type: "info", seq, ok: true, game: this.getInfo() });
  }

  private handleLeaderboard(ws: ServerWebSocket<SocketData>, msg: Record<string, unknown>, seq?: number): void {
    const gameId = typeof msg.gameId === "string" ? msg.gameId : "";
    const items = this.store.leaderboard(gameId, LEADERBOARD_LIMIT);
    reply(ws, { type: "leaderboard", seq, ok: true, data: { gameId, items } });
  }

  private async handleUpload(ws: ServerWebSocket<SocketData>, msg: Record<string, unknown>, seq?: number): Promise<void> {
    const core = this.opts.core;
    if (this.locked) {
      reply(ws, { type: "upload", seq, ok: false, error: "wallet locked" });
      return;
    }
    const info = this.getInfo();
    if (!info.feeAddress) {
      reply(ws, {
        type: "upload",
        seq,
        ok: false,
        error: "game reward account not configured (dexcoin.conf gamefeeaddress)",
      });
      return;
    }
    if (!validateAddress(info.feeAddress)) {
      reply(ws, { type: "upload", seq, ok: false, error: "game fee address is not a valid EDX address" });
      return;
    }
    const gameId = typeof msg.gameId === "string" ? msg.gameId : "";
    const uploadId = typeof msg.uploadId === "string" ? msg.uploadId : "";
    // Idempotent: same (gameId, uploadId) already stored locally → ack without re-broadcasting/charging (retries don't consume the daily cap)
    const existing = this.store.findByUploadId(gameId, uploadId);
    if (existing) {
      reply(ws, { type: "upload", seq, ok: true, duplicate: true, txid: existing.txid });
      return;
    }
    const feeSat = parseEdxAmount(info.fee);
    const localCap = parseEdxAmount(this.opts.config.gameFee);
    if (feeSat > localCap) {
      reply(ws, {
        type: "upload",
        seq,
        ok: false,
        error: `game fee ${info.fee} EDX exceeds the local cap ${this.opts.config.gameFee} EDX (dexcoin.conf gamefee)`,
      });
      return;
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    if (todayKey !== this.dailyKey) {
      this.dailyKey = todayKey;
      this.dailyFeeSat = 0n;
    }
    const capSat = parseEdxAmount(this.opts.config.gameFeePerDay);
    if (feeSat + this.dailyFeeSat > capSat) {
      reply(ws, {
        type: "upload",
        seq,
        ok: false,
        error: `daily game fee cap reached (${this.opts.config.gameFeePerDay} EDX per day; reset at UTC midnight)`,
      });
      return;
    }
    // Auto-sign a tip transaction (amount = gamefee) and broadcast it on-chain; txid is the on-chain anchor for this upload
    let txid: string;
    try {
      const feeTx = await core.buildGameFeeTx([{ address: info.feeAddress, amount: info.fee }], this.opts.password);
      txid = (await core.conn.request<{ txid: string }>("POST", "/transactions", feeTx)).txid;
    } catch (error) {
      reply(ws, { type: "upload", seq, ok: false, error: errorMessage(error) });
      return;
    }
    const kind = typeof msg.kind === "string" ? msg.kind : "";
    this.store.insert({
      gameId,
      kind,
      uploadId: typeof msg.uploadId === "string" ? msg.uploadId : "",
      name: typeof msg.name === "string" ? msg.name : null,
      score: typeof msg.score === "number" ? msg.score : null,
      wave: typeof msg.wave === "number" ? msg.wave : null,
      lives: typeof msg.lives === "number" ? msg.lives : null,
      payload: this.buildStoredPayload(msg),
      txid,
      createdAt: Date.now(),
    });
    this.dailyFeeSat += feeSat;
    reply(ws, { type: "upload", seq, ok: true, duplicate: false, txid });
  }

  /** Stores the save payload: encrypted into an ECIES envelope when a commKey is present (game.db never holds plaintext); stored as-is without one. */
  private buildStoredPayload(msg: Record<string, unknown>): string | null {
    const raw = msg.payload;
    if (raw === undefined) return null;
    if (!this.opts.commKey) return typeof raw === "string" ? raw : JSON.stringify(raw);
    return JSON.stringify(encryptJson(raw, this.opts.commKey.publicKeyHex));
  }

  private handleSaveGet(ws: ServerWebSocket<SocketData>, msg: Record<string, unknown>, seq?: number): void {
    const gameId = typeof msg.gameId === "string" ? msg.gameId : "";
    const record = this.store.findSave(gameId);
    if (!record || !record.payload) {
      reply(ws, { type: "save:get", seq, ok: true, payload: null });
      return;
    }
    if (!this.opts.commKey) {
      reply(ws, { type: "save:get", seq, ok: false, error: "communication key unavailable; cannot decrypt save" });
      return;
    }
    reply(ws, { type: "save:get", seq, ok: true, payload: this.decryptStoredPayload(record.payload) });
  }

  /** Decrypts a save: on failure (plaintext save written with no key) returns it as-is; plaintext only ever leaves here over ws:// localhost. */
  private decryptStoredPayload(stored: string): unknown {
    try {
      return decryptJson(JSON.parse(stored) as never, this.opts.commKey!.privateKeyHex);
    } catch {
      return stored;
    }
  }

  private handleRewards(ws: ServerWebSocket<SocketData>, seq?: number): void {
    const info = this.getInfo();
    reply(ws, {
      type: "rewards",
      seq,
      ok: true,
      data: {
        rewards: info.rewards,
        settleHourUtc: info.settleHourUtc,
        cycleStart: info.cycleStart,
        cycleEnd: info.cycleEnd,
        nextSettle: info.nextSettle,
      },
    });
  }

  /** Game config mirror: from local dexcoin.conf (the old build requested the backend /api/game/info; the decentralized build has no backend). */
  private getInfo(): GameInfo {
    return buildGameInfo(this.opts.config);
  }
}