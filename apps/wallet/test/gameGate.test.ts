import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFromPublicKey, generateKeyPair } from "@edgex/shared";
import type { SignedTransaction } from "@edgex/shared";
import { EventBus } from "../src/core/eventBus";
import { GameGate } from "../src/game/gameGate";
import { GameStore } from "../src/game/gameStore";
import { encryptCommKeyFile, decryptCommKeyFile, loadOrCreateCommKey, type CommKey } from "../src/keys/commKey";
import { Logger } from "../src/utils/log";
import { DEFAULT_MAX_SEGMENT_BYTES } from "../src/config/config";
import type { WalletConfig } from "../src/config/config";
import type { WalletCore } from "../src/core/walletCore";

function validAddress(): string {
  return addressFromPublicKey(generateKeyPair().publicKeyHex);
}

function testConfig(datadir: string, overrides: Partial<WalletConfig> = {}): WalletConfig {
  return {
    datadir,
    confPath: "",
    server: true,
    rpcuser: "",
    rpcpassword: "",
    listen: false,
    addnodes: [],
    nodeUrl: "http://127.0.0.1:28332",
    gamePort: 0,
    gameOrigins: ["*"],
    gamePairToken: "pair-token",
    gameFee: "0.001",
    gameFeePerDay: "0.5",
    gameFeeAddress: validAddress(),
    gameMinScore: 0,
    gameRewards: [],
    gameSettleHourUtc: 8,
    gameMaxSize: 65536,
    gameMaxFreq: 60,
    maxSegmentBytes: DEFAULT_MAX_SEGMENT_BYTES,
    ...overrides,
  };
}

/** Finds a free port (the game gateway only listens on 127.0.0.1). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

interface StubCoreCalls {
  builds: number;
  broadcasts: number;
  txidIndex: number;
}

function stubCore(calls: StubCoreCalls = { builds: 0, broadcasts: 0, txidIndex: 0 }): WalletCore {
  return {
    bus: new EventBus(),
    getAddress: () => "EDXWALLET",
    buildGameFeeTx: async () => {
      calls.builds += 1;
      return {
        inputs: [{ txid: "a".repeat(64), index: 0 }],
        outputs: [{ address: validAddress(), amount: "0.00100000" }],
        fee: "0.00000001",
        pubkey: "02" + "a".repeat(64),
        signature: "b".repeat(128),
      } as SignedTransaction;
    },
    conn: {
      request: async (_method: string, path: string, _body?: unknown) => {
        if (path !== "/transactions") throw new Error(`unexpected path ${path}`);
        calls.broadcasts += 1;
        return { txid: `tx-${++calls.txidIndex}` };
      },
    },
  } as unknown as WalletCore;
}

/** Simplified WS client: queues incoming messages + timeout protection. */
interface TestSocket {
  socket: WebSocket;
  send: (payload: unknown) => void;
  next: (timeoutMs?: number) => Promise<unknown>;
  closed: Promise<CloseEvent>;
}

function testSocket(port: number): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];
    let closedResolve: (event: CloseEvent) => void = () => undefined;
    const closed = new Promise<CloseEvent>((resolveClose) => {
      closedResolve = resolveClose;
    });
    socket.addEventListener("open", () => {
      resolve({
        socket,
        send: (payload) => socket.send(JSON.stringify(payload)),
        next: (timeoutMs = 5000) => {
          const queued = queue.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("waiting for ws reply timed out")), timeoutMs);
            waiters.push((value) => {
              clearTimeout(timer);
              res(value);
            });
          });
        },
        closed,
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    });
    socket.addEventListener("close", (event) => closedResolve(event));
    socket.addEventListener("error", () => reject(new Error("websocket error")));
  });
}

function freshCalls(): StubCoreCalls {
  return { builds: 0, broadcasts: 0, txidIndex: 0 };
}

describe("game gateway", () => {
  let dir: string;
  let commKey: CommKey;
  const gates: GameGate[] = [];

  afterEach(() => {
    for (const gate of gates) gate.stop();
    gates.length = 0;
  });

  async function startGate(overrides: Partial<WalletConfig>, calls: StubCoreCalls) {
    dir = mkdtempSync(join(tmpdir(), "edgex-gate-"));
    commKey = loadOrCreateCommKey(dir, { password: "pw" });
    const port = await freePort();
    const config = testConfig(dir, { ...overrides, gamePort: port });
    const core = stubCore(calls);
    const gate = new GameGate({ config, core, commKey, password: "pw", log: new Logger() });
    gate.start();
    gates.push(gate);
    return { port, config, gate, core };
  }

  test("rejects connections from origins outside the whitelist", async () => {
    const { port } = await startGate({ gameOrigins: ["http://localhost:8080"] }, freshCalls());
    // Origin outside the whitelist: rejected directly at the HTTP layer with 403
    const forbidden = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: "https://evil.example" } });
    expect(forbidden.status).toBe(403);
    // Origin inside the whitelist: passes the Origin check (no upgrade header, so 400 rather than 403)
    const allowed = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: "http://localhost:8080" } });
    expect(allowed.status).toBe(400);
  });

  test("hello validates the pairing token and reports wallet state", async () => {
    const { port } = await startGate({ gamePairToken: "pair-token" }, freshCalls());
    const client = await testSocket(port);
    // Wrong token: rejected and disconnected
    client.send({ type: "hello", token: "wrong" });
    const rejected = (await client.next()) as { type: string; ok: boolean };
    expect(rejected.type).toBe("hello");
    expect(rejected.ok).toBe(false);
    expect((await client.closed).code).toBe(4003);

    // Correct token: returns address/comm public key/unlock status/game config
    const client2 = await testSocket(port);
    client2.send({ type: "hello", token: "pair-token" });
    const hello = (await client2.next()) as {
      ok: boolean;
      unlocked: boolean;
      address: string;
      commKey: string;
      game: { fee: string; settleHourUtc: number };
    };
    expect(hello.ok).toBe(true);
    expect(hello.unlocked).toBe(true);
    expect(hello.address).toBe("EDXWALLET");
    expect(hello.commKey).toBe(commKey.publicKeyHex);
    expect(hello.game.fee).toBe("0.001");
    expect(hello.game.settleHourUtc).toBe(8);
    client2.socket.close();
  });

  test("unauthenticated connections cannot do anything", async () => {
    const { port } = await startGate({ gamePairToken: "" }, freshCalls());
    const client = await testSocket(port);
    client.send({ type: "upload", gameId: "snake", uploadId: "u1", score: 1 });
    const reply = (await client.next()) as { type: string; ok: boolean; error: string };
    expect(reply.type).toBe("error");
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/not authorized/);
    expect((await client.closed).code).toBe(4003);
  });

  test("upload signs a fee tx, broadcasts on-chain and is idempotent on retry", async () => {
    const calls: StubCoreCalls = { builds: 0, broadcasts: 0, txidIndex: 0 };
    const { port, config } = await startGate({ gamePairToken: "" }, calls);
    const client = await testSocket(port);
    client.send({ type: "hello" });
    await client.next();

    client.send({ type: "upload", gameId: "snake", kind: "score", uploadId: "u1", name: "alice", score: 120, wave: 3, lives: 2 });
    const first = (await client.next()) as { type: string; ok: boolean; duplicate: boolean; txid: string };
    expect(first.type).toBe("upload");
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.txid).toBe("tx-1");
    expect(calls.builds).toBe(1);
    expect(calls.broadcasts).toBe(1);

    // Retrying the same uploadId: replies duplicate directly, no re-signing or re-broadcasting
    client.send({ type: "upload", gameId: "snake", kind: "score", uploadId: "u1", name: "alice", score: 120 });
    const retry = (await client.next()) as { type: string; ok: boolean; duplicate: boolean; txid: string };
    expect(retry.ok).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect(retry.txid).toBe("tx-1");
    expect(calls.builds).toBe(1);
    expect(calls.broadcasts).toBe(1);

    // Record persisted in the local ledger
    const store = new GameStore(config.datadir);
    const record = store.findByUploadId("snake", "u1");
    expect(record).not.toBeNull();
    expect(record!.score).toBe(120);
    expect(record!.txid).toBe("tx-1");
    store.close();

    // Leaderboard
    client.send({ type: "leaderboard", gameId: "snake" });
    const board = (await client.next()) as { data: { items: Array<{ score: number }> } };
    expect(board.data.items.length).toBe(1);
    expect(board.data.items[0]!.score).toBe(120);
    client.socket.close();
  });

  test("daily fee cap blocks new uploads but duplicate retries still pass", async () => {
    const calls: StubCoreCalls = { builds: 0, broadcasts: 0, txidIndex: 0 };
    const { port } = await startGate({ gamePairToken: "", gameFeePerDay: "0.001" }, calls);
    const client = await testSocket(port);
    client.send({ type: "hello" });
    await client.next();

    // The first upload consumes the whole daily cap
    client.send({ type: "upload", gameId: "snake", kind: "score", uploadId: "u1", score: 1 });
    const first = (await client.next()) as { ok: boolean; duplicate: boolean };
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);

    // A new upload is rejected by the daily cap
    client.send({ type: "upload", gameId: "snake", kind: "score", uploadId: "u2", score: 2 });
    const blocked = (await client.next()) as { ok: boolean; error: string };
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/daily game fee cap/);

    // Duplicate uploads are unaffected by the daily cap (retries never double-charge)
    client.send({ type: "upload", gameId: "snake", kind: "score", uploadId: "u1", score: 1 });
    const retry = (await client.next()) as { ok: boolean; duplicate: boolean };
    expect(retry.ok).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect(calls.broadcasts).toBe(1);
    client.socket.close();
  });

  test("save payload encrypts at rest and decrypts on save:get", async () => {
    const { port } = await startGate({ gamePairToken: "" }, freshCalls());
    const client = await testSocket(port);
    client.send({ type: "hello" });
    await client.next();

    client.send({ type: "upload", gameId: "snake", kind: "save", uploadId: "s1", payload: { level: 5, hp: 3 } });
    const uploaded = (await client.next()) as { ok: boolean };
    expect(uploaded.ok).toBe(true);

    client.send({ type: "save:get", gameId: "snake" });
    const reply = (await client.next()) as { type: string; ok: boolean; payload: { level: number; hp: number } | null };
    expect(reply.type).toBe("save:get");
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({ level: 5, hp: 3 });
    client.socket.close();
  });

  test("wallet lock disconnects game sockets and blocks uploads", async () => {
    const calls: StubCoreCalls = { builds: 0, broadcasts: 0, txidIndex: 0 };
    const { port, core } = await startGate({ gamePairToken: "" }, calls);

    const client = await testSocket(port);
    client.send({ type: "hello" });
    await client.next();

    // Wallet lock: drop all game connections
    core.bus.emit("auth:change", false);
    expect((await client.closed).code).toBe(4001);

    // While locked, hello is still readable (unlocked=false), but upload is rejected
    const client2 = await testSocket(port);
    client2.send({ type: "hello" });
    const hello = (await client2.next()) as { unlocked: boolean };
    expect(hello.unlocked).toBe(false);
    client2.send({ type: "upload", gameId: "snake", uploadId: "u1", score: 1 });
    const reply = (await client2.next()) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("wallet locked");
    expect(calls.broadcasts).toBe(0);
    client2.socket.close();
  });
});

describe("communication key", () => {
  test("v2 encryption round-trips and rejects a wrong password", () => {
    const pair = generateKeyPair();
    const file = encryptCommKeyFile(pair, "secret");
    expect(file.v).toBe(2);
    expect(decryptCommKeyFile(file, "secret")).toBe(pair.privateKeyHex);
    expect(() => decryptCommKeyFile(file, "wrong")).toThrow(/Wrong password/);
  });

  test("loadOrCreateCommKey persists and reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-commkey-"));
    const created = loadOrCreateCommKey(dir, { password: "pw" });
    const reloaded = loadOrCreateCommKey(dir, { password: "pw" });
    expect(reloaded.privateKeyHex).toBe(created.privateKeyHex);
    expect(() => loadOrCreateCommKey(dir)).toThrow(/password-encrypted/);
  });
});