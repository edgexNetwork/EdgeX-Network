import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDX_UNIT,
  addressFromPublicKey,
  bytesToHex,
  formatEdxAmount,
  generateKeyPair,
  sha256,
} from "@edgex/shared";
import {
  calculateMerkleRoot,
  GENESIS_BLOCK,
  GENESIS_HASH,
  serializeMiningBlob,
} from "@edgex/core";
import type { Block, BlockHeader, PowVerifier } from "@edgex/core";
import { BlockchainStore } from "../../node/src/storage";
import { ChainService } from "../../node/src/service";
import { P2PNetwork } from "../../node/src/p2p";
import { ConnectionManager } from "../src/core/connection";
import { ChainStore } from "../src/core/walletDatabase";
import { Logger } from "../src/utils/log";

/** Test verifier that accepts any well-formed 64-hex hash (no real proof-of-work). */
class AcceptedVerifier implements PowVerifier {
  verify(_blob: Uint8Array, claimedHashHex: string): boolean {
    return /^[0-9a-f]{64}$/.test(claimedHashHex);
  }
}

const MINER = addressFromPublicKey(generateKeyPair().publicKeyHex);

/** Build a deterministic next block on top of the given parent. */
function buildBlock(parent: Block, timestampSeconds: number): Block {
  const height = parent.header.height + 1;
  const subsidy = 400n * EDX_UNIT;
  const coinbase = { outputs: [{ address: MINER, amount: formatEdxAmount(subsidy) }] };
  const header: BlockHeader = {
    version: 1,
    height,
    previousHash: parent.hash,
    timestampSeconds,
    difficulty: parent.header.difficulty,
    merkleRoot: calculateMerkleRoot(height, coinbase, []),
    powSeed: GENESIS_HASH,
    payoutAddress: MINER,
  };
  const nonce = timestampSeconds % 1_000_000;
  return {
    header,
    hash: bytesToHex(sha256(serializeMiningBlob(header, nonce))),
    nonce,
    coinbase,
    transactions: [],
  };
}

describe("wallet chain download over the peer link", () => {
  const root = mkdtempSync(join(tmpdir(), "edgex-wallet-p2p-"));
  let caseDirectory = "";
  let store: BlockchainStore;
  let service: ChainService;
  let network: P2PNetwork;
  let conn: ConnectionManager;
  let local: ChainStore;

  const logger = new Logger();

  /**
   * Spin up a real full node whose REST surface (chain info + block paging) is
   * served through the peer tunnel, mine `blocksToMine` blocks, then point a
   * wallet connection manager at the node over its WebSocket link only.
   */
  function startPeerAndWallet(blocksToMine: number): void {
    mkdirSync(caseDirectory, { recursive: true });
    store = new BlockchainStore(join(caseDirectory, "chain.sqlite"));
    service = new ChainService(new AcceptedVerifier(), store, "test-network");

    network = new P2PNetwork(
      0,
      "wallet-sync-node",
      () => ({ height: service.chain.height, bestHash: service.chain.bestBlockHash }),
      () => undefined,
      (block) => {
        try {
          service.acceptBlock(block);
        } catch {
          // Invalid peer blocks are rejected without disconnecting the peer.
        }
      },
    );
    network.setPeerDataSource({
      status: () => {
        const hash = service.chain.bestBlockHash;
        const totalWork = service.chain.cumulativeWorkFrom(hash) ?? 0n;
        return { height: service.chain.height, bestHash: hash, totalWork: totalWork.toString() };
      },
      chainAtHeight: (height) => service.chain.chainAtHeight(height),
      cumulativeWorkFrom: (hash) => service.chain.cumulativeWorkFrom(hash),
      has: (hash) => service.chain.has(hash),
      peerStatus: () => ({ connected: network.peerCount, total: 0, items: [] }),
    });
    service.onBlockAccepted = () => network.notifyChainAdvanced();
    network.setRpcHandler((method, path, body) =>
      handleNodeRequest(method, path, body, service, network),
    );
    network.start([]);
    const nodeUrl = `ws://127.0.0.1:${network.boundPort}/p2p`;

    // Mine the requested number of blocks locally before the wallet connects.
    for (let index = 0; index < blocksToMine; index += 1) {
      const parent = service.chain.get(service.chain.bestBlockHash).block;
      service.acceptBlock(buildBlock(parent, GENESIS_BLOCK.header.timestampSeconds + 30 + index * 20));
    }

    // The wallet connection manager talks to the node over the peer link only.
    conn = new ConnectionManager({
      nodeUrl,
      configuredNodes: [],
      nodeId: "wallet-own-address",
      log: logger,
    });

    local = new ChainStore(join(caseDirectory, "wallet-chain.db"));
    local.open();
  }

  /** The wallet download loop: page canonical blocks and append locally. */
  async function synchronizeWallet(): Promise<{ localHeight: number; networkHeight: number }> {
    // The transport-level request keeps the HTTP-like {status, data} envelope;
    // the wallet core normally unwraps it through ConnectionManager.request.
    const infoResult = await conn.requestTransport("GET", "/chain/info");
    if (infoResult.status < 200 || infoResult.status >= 300) throw new Error(`node returned HTTP ${infoResult.status}`);
    const info = (infoResult.data ?? {}) as Record<string, unknown>;
    const networkHeight = Number(info.height ?? 0);
    while (local.localHeight() < networkHeight) {
      const startHeight = Math.max(0, local.localHeight() + 1);
      const pageResult = await conn.requestTransport("GET", `/chain/blocks?start=${startHeight}&limit=200`);
      if (pageResult.status < 200 || pageResult.status >= 300) throw new Error(`node returned HTTP ${pageResult.status}`);
      const items = ((pageResult.data ?? {}) as { items?: unknown[] }).items ?? [];
      if (items.length === 0) break;
      local.appendBlocks(items as Block[]);
    }
    return { localHeight: local.localHeight(), networkHeight };
  }

  beforeEach(() => {
    caseDirectory = join(root, `case-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    network?.stop();
    conn?.stop();
    local?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("downloads the full chain into the local wallet database via the peer link", async () => {
    startPeerAndWallet(5);
    const connected = await conn.refreshConnection();
    expect(connected).toBe(true);

    const { localHeight, networkHeight } = await synchronizeWallet();
    expect(networkHeight).toBe(5);
    expect(localHeight).toBe(networkHeight);
    expect(local.localTip().hash).toBe(service.chain.bestBlockHash);
    expect(local.genesisHash()).toBe(GENESIS_HASH);
  });

  test("keeps the wallet database consistent with a node that keeps extending", async () => {
    startPeerAndWallet(2);
    const connected = await conn.refreshConnection();
    expect(connected).toBe(true);

    const first = await synchronizeWallet();
    expect(first.localHeight).toBe(2);

    // The node mines more blocks while the wallet is connected; a later sync
    // round appends only the missing heights.
    for (let index = 0; index < 3; index += 1) {
      const parent = service.chain.get(service.chain.bestBlockHash).block;
      service.acceptBlock(buildBlock(parent, GENESIS_BLOCK.header.timestampSeconds + 60 + index * 20));
    }
    const second = await synchronizeWallet();
    expect(second.localHeight).toBe(5);
    expect(local.localTip().hash).toBe(service.chain.bestBlockHash);
  });
});

/** Serve the two node endpoints the wallet sync loop needs. */
function handleNodeRequest(
  method: "GET" | "POST",
  path: string,
  _body: unknown,
  service: ChainService,
  network: P2PNetwork,
): Promise<{ status: number; data: unknown }> {
  const url = new URL(`http://p2p.local${path}`);
  const respond = (data: unknown, status = 200) => Promise.resolve({ status, data });
  if (method === "GET" && url.pathname === "/chain/info") {
    return respond({
      networkId: "test-network",
      genesisHash: GENESIS_HASH,
      height: service.chain.height,
      bestHash: service.chain.bestBlockHash,
      totalIssued: formatEdxAmount(service.chain.totalIssued),
      mempoolSize: 0,
      lastBlockTime: service.chain.get(service.chain.bestBlockHash).block.header.timestampSeconds,
      difficulty: "1000000",
      networkHashps: 0,
      networkPower: 0,
    });
  }
  if (method === "GET" && url.pathname === "/chain/blocks") {
    const start = Number.parseInt(url.searchParams.get("start") ?? "0", 10);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    // BigInt fields travel as decimal strings over the wire; the peer layer
    // rehydrates them into consensus blocks on receipt.
    const wireBlocks = service.canonicalBlocks(start, limit).map((block) => ({
      ...block,
      header: { ...block.header, difficulty: block.header.difficulty.toString() },
    }));
    return respond({ items: wireBlocks });
  }
  void network;
  return respond({ error: "not found" }, 404);
}
