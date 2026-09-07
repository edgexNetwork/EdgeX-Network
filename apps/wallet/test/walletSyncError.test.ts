import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GENESIS_BLOCK } from "@edgex/core";
import type { Block } from "@edgex/core";
import { DEFAULT_MAX_SEGMENT_BYTES, type WalletConfig } from "../src/config/config";
import type { ConnectionManager } from "../src/core/connection";
import { chainSyncHooks, WalletCore } from "../src/core/walletCore";
import { ChainStore } from "../src/core/walletDatabase";
import { deriveWalletKey } from "../src/keys/walletKeyClean";

const ZEROS64 = "0".repeat(64);
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function hashOf(height: number): string {
  return `hash-${String(height).padStart(6, "0")}`;
}

function createTestConfig(datadir: string): WalletConfig {
  return {
    datadir,
    confPath: join(datadir, "dexcoin.conf"),
    server: false,
    rpcuser: "edx",
    rpcpassword: "edx-secret",
    listen: false,
    addnodes: [],
    nodeUrl: "http://127.0.0.1:28332",
    gameOrigins: [],
    gamePairToken: "",
    gameFee: "0.001",
    gameFeePerDay: "0.5",
    gameFeeAddress: "",
    gameMinScore: 0,
    gameRewards: [],
    gameSettleHourUtc: 8,
    gameMaxSize: 65536,
    gameMaxFreq: 60,
    maxSegmentBytes: DEFAULT_MAX_SEGMENT_BYTES,
  } as WalletConfig;
}

/** Build a chain-store compatible block (bare, no coinbase/transactions). */
function block(height: number, prevHash: string): Block {
  return {
    header: {
      version: 1,
      height,
      previousHash: prevHash,
      timestampSeconds: GENESIS_BLOCK.header.timestampSeconds + height * 15,
      difficulty: GENESIS_BLOCK.header.difficulty,
      merkleRoot: ZEROS64,
      powSeed: GENESIS_BLOCK.header.powSeed,
      payoutAddress: "",
    },
    hash: hashOf(height),
    nonce: height,
    coinbase: null,
    transactions: [],
  };
}

function healthyChain(heights: number[]): Block[] {
  return heights.map((height) => block(height, height === 0 ? ZEROS64 : hashOf(height - 1)));
}

/**
 * A programmable node stub for the wallet sync loop.
 *
 * `healthy` is the canonical chain served in pages of 200. `failures` lists
 * (startHeight, block) pairs that are answered once each with a corrupt block
 * before healthy data takes over again, simulating a transient page drift.
 * `persistentCorrupt` is a block that is served on every request for its
 * height, simulating a node that keeps handing over unlinkable data.
 */
function syncConnStub(opts: {
  healthy: Block[];
  failures?: Array<{ start: number; block: Block }>;
  persistentCorrupt?: Block;
}): ConnectionManager {
  const { healthy, failures = [], persistentCorrupt } = opts;
  const failureBudget = new Map(failures.map((failure) => [failure.start, failure.block]));
  const served = new Set<number>();
  return {
    connectedCount: 1,
    stop: () => undefined,
    requestTransport: async (method: "GET", path: string) => {
      const url = new URL(`http://node.local${path}`);
      const start = Number.parseInt(url.searchParams.get("start") ?? "0", 10);
      if (persistentCorrupt && persistentCorrupt.header.height === start) {
        return { status: 200, data: { items: [persistentCorrupt] } };
      }
      if (failureBudget.has(start) && !served.has(start)) {
        served.add(start);
        return { status: 200, data: { items: [failureBudget.get(start)!] } };
      }
      const from = healthy.findIndex((candidate) => candidate.header.height === start);
      const items = from >= 0 ? healthy.slice(from, from + 200) : [];
      return { status: 200, data: { items } };
    },
    request: async (method: "GET", path: string) => {
      if (path === "/chain/info") {
        const tip = healthy[healthy.length - 1]!;
        return {
          height: tip.header.height,
          bestHash: tip.hash,
          genesisHash: hashOf(0),
          totalIssued: "40000.00000000",
          mempoolSize: 0,
        };
      }
      throw new Error(`unexpected node request: ${method} ${path}`);
    },
  } as unknown as ConnectionManager;
}

describe("wallet local chain sync error handling", () => {
  const root = mkdtempSync(join(tmpdir(), "edgex-wallet-sync-error-"));
  let directory: string;
  let core: WalletCore;
  let database: ChainStore;
  let mutable: { conn: ConnectionManager };
  const updates: string[] = [];

  beforeEach(() => {
    directory = join(root, `case-${Math.random().toString(36).slice(2)}`);
    mkdirSync(directory, { recursive: true });
    const key = deriveWalletKey(MNEMONIC);
    core = new WalletCore(createTestConfig(directory), key, { debug() {}, info() {}, warn() {}, error() {} } as never);
    // The wallet core never starts its timers here; the local chain database
    // is opened directly and the node connection is a canned stub.
    database = core.database;
    const opened = database.open();
    if (!opened.ok) throw new Error(`chain db open failed: ${opened.error}`);
    mutable = core as unknown as { conn: ConnectionManager };
    updates.length = 0;
    core.bus.on("chain:update", () => {
      updates.push(core.chain.toView().syncStatus);
    });
    // Zero the re-anchor backoff so repeated failures escalate immediately.
    chainSyncHooks.sleep = async () => undefined;
  });

  afterEach(() => {
    database.close();
    core.stop();
    chainSyncHooks.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        // Windows releases sqlite handles slowly; retry.
      }
    }
  });

  test("a single page drift is retried and does not flag a data error", async () => {
    const chain = healthyChain([0, 1, 2, 3, 4]);
    // The height-0 page is answered once with a genesis block whose hash does
    // not match the expected genesis, so the append throws ChainDataError. The
    // sync loop re-anchors and the healthy page arrives on the next attempt.
    const badGenesis = { ...chain[0]!, hash: hashOf(99) };
    const conn = syncConnStub({ healthy: chain, failures: [{ start: 0, block: badGenesis }] });
    mutable.conn = conn;

    await (core as unknown as { synchronizeLocalDatabase(h: number, g: string): Promise<void> }).synchronizeLocalDatabase(
      4,
      hashOf(0),
    );
    expect(core.chain.syncStatus).toBe("synced");
    expect(database.localHeight()).toBe(4);
    expect(core.chain.syncError).toBeNull();
  });

  test("persistent unlinkable pages latch the error state without exiting", async () => {
    // The healthy chain only reaches height 1 locally; every request for a
    // missing height is answered with a height-1 block whose prevHash does not
    // link to anything the local database holds. Each attempt appends nothing
    // and re-anchors; after MAX_ANCHOR_FAILURES the wallet latches the error.
    const healthy = healthyChain([0]);
    const evil = block(1, "f".repeat(64));
    const conn = syncConnStub({ healthy, persistentCorrupt: evil });
    mutable.conn = conn;

    await (core as unknown as { synchronizeLocalDatabase(h: number, g: string): Promise<void> }).synchronizeLocalDatabase(
      5,
      hashOf(0),
    );
    expect(core.chain.syncStatus).toBe("error");
    expect(core.chain.syncError).toContain("Blockchain data error");
    // The wallet process object is untouched: the core instance still works,
    // no error escapes the sync loop, and the local database keeps its tip.
    expect(database.localHeight()).toBe(0);
    expect(updates).toContain("error");
  });

  test("resync clears the error state and rebuilds from healthy data", async () => {
    const healthy = healthyChain([0]);
    const evil = block(1, "f".repeat(64));
    const conn = syncConnStub({ healthy, persistentCorrupt: evil });
    mutable.conn = conn;

    await (core as unknown as { synchronizeLocalDatabase(h: number, g: string): Promise<void> }).synchronizeLocalDatabase(
      5,
      hashOf(0),
    );
    expect(core.chain.syncStatus).toBe("error");

    // The node heals; resync rebuilds the database and downloads again.
    const healed = syncConnStub({ healthy: healthyChain([0, 1, 2, 3, 4]) });
    mutable.conn = healed;
    await core.resync();
    expect(core.chain.syncStatus).toBe("synced");
    expect(core.chain.syncError).toBeNull();
    expect(database.localHeight()).toBe(4);
  });
});
