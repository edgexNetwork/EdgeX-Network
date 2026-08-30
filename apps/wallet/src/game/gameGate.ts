import type { ServerWebSocket } from "bun";
import { decryptJson, encryptJson, parseEdxAmount, validateAddress } from "@edgex/shared";
import type { WalletConfig } from "../config/config";
import type { CommKey } from "../keys/commKey";
import type { WalletCore } from "../core/walletCore";
import type { Logger } from "../utils/log";
import { GameStore } from "./gameStore";

/**
 * 游戏配置镜像（旧中心化版由后端 /api/game/info 下发；去中心化版从 dexcoin.conf 本地解析，
 * 字段对齐旧 DTO，游戏页无需感知差异）。cycleStart/cycleEnd/nextSettle 按 gamesettlehourutc 推算。
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

/** 单连接每分钟消息数上限（防本地端口被连发刷爆）。 */
const MAX_MSG_PER_MINUTE = 180;
/** 排行榜返回条数上限。 */
const LEADERBOARD_LIMIT = 50;

export interface GameGateOptions {
  config: WalletConfig;
  core: WalletCore;
  commKey?: CommKey;
  /** 钱包密码（TUI 解锁后内存持有 / daemon 的 EDX_WALLET_PASSWORD）；缺失时上传被拒，仅只读查询可用。 */
  password?: string;
  log: Logger;
}

/** WS 连接附加数据：握手时记录的 Origin + hello 配对结果。 */
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

/** 按每日结算小时（UTC）推算当前结算周期窗口。 */
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
 * 本地游戏网关：游戏页面（公网域名）→ ws://127.0.0.1:gameport → 本钱包。
 * - 仅监听 127.0.0.1；握手校验 Origin ∈ dexcoin.conf 的 gameorigins 白名单（`*` = 放行全部，仅建议本地调试）；
 * - hello 校验配对令牌（gamepairtoken，可选）并把令牌记为本会话授权；未 hello 的连接不能做任何操作；
 * - upload 由钱包自动签一笔小费交易（金额 = gamefee，受 gamefee / gamefeeperday 上限钳制）并直接广播上链，
 *   数据记录落在钱包本地账本（game.db），uploadId 幂等、重试不重复扣费；
 * - 存档读取（save:get）用钱包 comm 私钥解密，明文仅在 localhost 内回传游戏页；
 * - 钱包锁定（auth:change=false）时断开全部连接，游戏无法继续。
 */
export class GameGate {
  private server: ReturnType<typeof Bun.serve<SocketData>> | null = null;
  private sockets = new Set<ServerWebSocket<SocketData>>();
  private readonly store: GameStore;
  /** 今日已扣小费累计（sat，内存计数，重启归零）。 */
  private dailyFeeSat = 0n;
  private dailyKey = "";
  /** 会话锁定标记：auth:change(false) 置位并断开全部连接；密码校验成功（auth:change(true)）复位。 */
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
        // 握手成功后连接由 Bun 接管（官方示例约定此处返回 undefined）
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
    // 除 hello 外一律要求已完成配对授权
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
    // 幂等：本地已存在同 (gameId, uploadId)，直接回执不重复广播/扣费（重试不消耗每日额度）
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
    // 自动签名小费交易（金额 = gamefee）并直接广播上链，txid 作为本次上传的链上锚点
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

  /** 存档载荷落库：有 commKey 时加密为 ECIES 信封（game.db 不落明文）；无密钥时原样存储。 */
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

  /** 解密存档：失败（无密钥写入的明文存档）原样回传，明文仅经 ws:// localhost 流出。 */
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

  /** 游戏配置镜像：来自本地 dexcoin.conf（旧版请求后端 /api/game/info，去中心化版无后端）。 */
  private getInfo(): GameInfo {
    return buildGameInfo(this.opts.config);
  }
}