import { afterEach, describe, expect, test } from "bun:test";
import type { WalletCore } from "../core/walletCore";
import type { ConnectionManager } from "../core/connection";
import { WalletRpcServer } from "./server";
import { GENESIS_BLOCK } from "@edgex/core";
import type { Block } from "@edgex/core";

/**
 * Full RPC surface tests: every method of the decentralized wallet RPC server
 * is exercised through the real JSON-RPC handler with a stubbed WalletCore.
 * The stub routes node REST calls through a fake ConnectionManager so the
 * methods that reach a node (submitblock, sendrawtransaction, ...) are tested
 * without starting any service.
 */

const EDX = 100_000_000n;

function createConfig() {
  return {
    datadir: ".",
    confPath: "dexcoin.conf",
    server: true,
    rpcuser: "edx",
    rpcpassword: "edx-secret",
    rpcport: 0,
    listen: false,
    addnodes: [],
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
    maxSegmentBytes: 500 * 1024 * 1024,
  } as const;
}

const ADDRESS = "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f";

/** A fake ConnectionManager that answers node REST routes with canned data. */
function fakeConn(overrides: Record<string, unknown> = {}): ConnectionManager {
  const baseRoutes: Record<string, unknown> = {
    "/chain/info": {
      height: 12,
      bestHash: "b".repeat(64),
      totalIssued: "4800.00000000",
      mempoolSize: 2,
      difficulty: "1000000",
      networkHashps: 66_667,
      networkPower: 66_667,
      genesisHash: GENESIS_BLOCK.hash,
    },
    [`/transactions/${"d".repeat(64)}`]: {
      txid: "d".repeat(64),
      type: "transfer",
      category: "send",
      amount: "10.00000000",
      fee: "0.00010000",
      status: "confirmed",
      confirmations: 3,
      matureAtHeight: null,
      height: 9,
      time: 1_767_225_700,
      from: ADDRESS,
      inputs: [{ txid: "c".repeat(64), index: 0, address: ADDRESS, amount: "100.00000000" }],
      outputs: [{ address: ADDRESS, amount: "89.99990000", isChange: true }],
    },
  };
  // The wallet key address, plus a second, foreign address (for scan coverage).
  for (const address of [ADDRESS, "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f".replace("kjt7f", "kjt70")]) {
    const utxosPath = `/wallet/utxos?address=${encodeURIComponent(address)}`;
    const historyPath = `/wallet/history?address=${encodeURIComponent(address)}&limit=20`;
    baseRoutes[utxosPath] = {
      items: [
        { txid: "c".repeat(64), index: 0, address, amount: "100.00000000", birthHeight: 6, isCoinbase: false, spendable: true },
      ],
    };
    baseRoutes[historyPath] = [
      {
        txid: "d".repeat(64),
        type: "transfer",
        category: "send",
        amount: "10.00000000",
        fee: "0.00010000",
        status: "confirmed",
        confirmations: 3,
        matureAtHeight: null,
        height: 9,
        time: 1_767_225_700,
        from: address,
        inputs: [{ txid: "c".repeat(64), index: 0, address, amount: "100.00000000" }],
        outputs: [{ address, amount: "89.99990000", isChange: true }],
      },
    ];
  }
  const routes = { ...baseRoutes, ...overrides };
  return {
    request: async (method: "GET" | "POST", path: string) => {
      if (method === "POST" && path === "/transactions") return { accepted: true, txid: "e".repeat(64) };
      if (method === "POST" && path === "/blocks") return { result: "extended" };
      if (method === "POST" && path === "/mining/template") {
        return {
          jobId: "job-1",
          height: 12,
          previousblockhash: "b".repeat(64),
          blobHex: "00ed",
          seedHash: "f".repeat(64),
          targetHex: "ff",
          difficulty: "1000000",
          block: { header: { previousHash: "b".repeat(64) } },
        };
      }
      const hit = routes[path];
      if (hit !== undefined) return hit;
      throw new Error(`unexpected node request: ${method} ${path}`);
    },
  } as unknown as ConnectionManager;
}

function stubCore(conn: ConnectionManager): WalletCore {
  return {
    conn,
    key: { address: ADDRESS, privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) },
    chain: {
      height: 12,
      hash: "b".repeat(64),
      prevHash: "a".repeat(64),
      blockReward: "400.00000000",
      supply: "4800.00000000",
      networkPower: 66_667,
      pendingCount: 2,
      connectedNodes: 1,
      lastBlockTime: 1_767_225_800,
      syncStatus: "synced",
      localHeight: 12,
    },
    getChainInfo: async () => ({
      chain: "edx",
      blocks: 12,
      latestHash: "b".repeat(64),
      backendHeight: 12,
      syncProgress: 1,
      localHeight: 12,
      syncStatus: "synced",
      syncError: null,
      lastBlockTime: 1_767_225_800,
      phase: 1,
      blockReward: "400.00000000",
      supply: "4800.00000000",
      networkPower: 66_667,
      pendingCount: 2,
      connectedNodes: 1,
    }),
    getMiningInfo: async () => ({ difficulty: "1000000", networkHashps: 66_667, hashrate: 0 }),
    getBlockCount: () => 12,
    getBalance: async () => "100.00000000",
    getAddress: () => ADDRESS,
    getNewAddress: () => ADDRESS,
    getRawChangeAddress: () => ADDRESS,
    walletAddresses: () => [ADDRESS],
    requirePassword: () => false,
    unlock: () => true,
    lock: () => undefined,
    getFees: async () => ({ slow: "0.01", normal: "0.05", fast: "0.1", recommended: "normal", pendingCount: 2 }),
    listTransactions: async () => [],
    getTransaction: async (txid: string) => (txid === "d".repeat(64)
      ? {
          txid,
          type: "transfer",
          category: "send",
          amount: "10.00000000",
          fee: "0.00010000",
          status: "confirmed",
          confirmations: 3,
          matureAtHeight: null,
          height: 9,
          time: 1_767_225_700,
          from: ADDRESS,
          inputs: [],
          outputs: [],
        }
      : null),
    getPeers: () => [{ id: 1, addr: "http://127.0.0.1:28332", connected: true, latencyMs: 5, source: "config" }],
    getConnectionCount: () => 1,
    send: async () => "f".repeat(64),
    listUnspent: async () => [
      { txid: "c".repeat(64), index: 0, address: ADDRESS, amount: "100.00000000", confirmations: 7 },
    ],
    listSinceBlock: async () => ({ transactions: [], lastblock: "b".repeat(64) }),
    getBalances: async () => ({ mine: { trusted: "100.00000000", untrusted_pending: "0", immature: "0" }, watchonly: { trusted: "0" }, unconfirmed: "0" }),
    getWalletInfo: () => ({ walletname: ADDRESS, balance: "100.00000000", keypoolsize: 1, unlocked_until: 0 }),
    validateAddress: (address: string) => ({ isvalid: address === ADDRESS, address, ismine: address === ADDRESS, iswatchonly: false, isscript: false, ischange: false }),
    getAddressInfo: (address: string) => ({ address, ismine: address === ADDRESS, iswatchonly: false, isscript: false, ischange: false, scriptPubKey: "", pubkey: address === ADDRESS ? "02".padEnd(66, "0") : "", index: 0 }),
    importAddress: () => true,
    dumpPrivKey: () => "0".repeat(64),
    signMessageForAddress: () => "0".repeat(128),
    verifyMessageForAddress: () => true,
    signRawTransaction: (hex: string) => ({ hex, complete: true }),
    fundRawTransaction: (hex: string) => ({ hex, fee: "0.00010000", changepos: -1 }),
    decodeRawTransaction: (hex: string) => ({ txid: "d".repeat(64), inputs: [], outputs: [], fee: "0.00010000" }),
    sendRawTransaction: async () => "e".repeat(64),
    testMempoolAccept: async () => [{ txid: "e".repeat(64), allowed: true }],
    getRawTransaction: async () => "00",
    getRawTransactionVerbose: async () => ({
      txid: "d".repeat(64),
      hex: "00",
      in_active_chain: true,
      inputs: [{ txid: "c".repeat(64), vout: 0, address: ADDRESS, amount: "100.00000000" }],
      outputs: [{ address: ADDRESS, amount: "89.99990000", isChange: true }],
      fee: "0.00010000",
      confirmations: 3,
      blockhash: "b".repeat(64),
      blocktime: 1_767_225_700,
      time: 1_767_225_700,
    }),
    scanTxOutSet: async () => ({
      success: true,
      txouts: 1,
      total_amount: "100.00000000",
      unspents: [{ txid: "c".repeat(64), vout: 0, address: ADDRESS, amount: "100.00000000", confirmations: 7, scriptPubKey: "" }],
    }),
    getTxOut: async () => ({ bestblock: "b".repeat(64), confirmations: 7, value: "100.00000000", scriptPubKey: { asm: "", type: "edx" } }),
    getTxOutSetInfo: async () => ({ height: 12, bestblock: "b".repeat(64), txouts: 0, bytes_serialized: 0, hash_serialized: "b".repeat(64), total_amount: "4800.00000000" }),
    getRawMempool: async () => ["x".repeat(64)],
    getMempoolInfo: async () => ({ size: 2, bytes: 500, usage: 500, maxmempool: 300_000_000, mempoolminfee: "0.00001000" }),
    getBlockHash: (height: number) => (height === 12 ? "b".repeat(64) : null),
    getBlockHeader: (hash: string) => (hash === "b".repeat(64)
      ? { hash, height: 12, previousblockhash: "a".repeat(64), time: 1_767_225_800, mediantime: 1_767_225_800, nTx: 0 }
      : null),
    getBlock: (hash: string) => (hash === "b".repeat(64) ? { hash, height: 12, tx: [] } : null),
    addNode: () => undefined,
    removeNode: () => true,
    requestStop: () => undefined,
    getMiningJob: async () => ({ jobId: "job-1", height: 12, previousblockhash: "b".repeat(64), blob: "00ed", seedHash: "f".repeat(64), target: "ff", difficulty: "1000000", coinbasevalue: "400.00000000" }),
    database: { isOpen: false, blockAt: () => null, localHeight: () => -1 } as unknown as WalletCore["database"],
  } as unknown as WalletCore;
}

async function rpcCall(server: WalletRpcServer, method: string, params: unknown[] = []): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const authorization = `Basic ${btoa("edx:edx-secret")}`;
  const response = await server.handle(new Request("http://127.0.0.1/", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  return response.json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
}

describe("wallet RPC full surface", () => {
  afterEach(() => {});

  function makeServer(): { server: WalletRpcServer; conn: ConnectionManager } {
    const conn = fakeConn();
    const server = new WalletRpcServer(createConfig() as never, stubCore(conn), {} as never);
    return { server, conn };
  }

  test("serves the blockchain info methods", async () => {
    const { server } = makeServer();
    const info = await rpcCall(server, "getblockchaininfo");
    expect((info.result as Record<string, unknown>).blocks).toBe(12);
    expect((info.result as Record<string, unknown>).chain).toBe("edx");
    expect((await rpcCall(server, "getblockcount")).result).toBe(12);
    expect((await rpcCall(server, "getbalance")).result).toBe("100.00000000");
    expect((await rpcCall(server, "getnewaddress")).result).toBe(ADDRESS);
    server.stop();
  });

  test("serves wallet transfer methods", async () => {
    const { server } = makeServer();
    const txid = await rpcCall(server, "sendtoaddress", [ADDRESS, "10.00000000"]);
    expect(txid.result).toBe("f".repeat(64));
    const many = await rpcCall(server, "sendmany", ["dummy", { [ADDRESS]: "1.00000000" }]);
    expect(many.result).toBe("f".repeat(64));
    const send = await rpcCall(server, "send", [[{ address: ADDRESS, amount: "1.00000000" }]]);
    expect(send.result).toBe("f".repeat(64));
    const all = await rpcCall(server, "sendall", [[ADDRESS]]);
    expect(all.error).toBeUndefined();
    server.stop();
  });

  test("serves transaction and fee methods", async () => {
    const { server } = makeServer();
    const tx = await rpcCall(server, "gettransaction", ["d".repeat(64)]);
    expect((tx.result as Record<string, unknown>).txid).toBe("d".repeat(64));
    // Wallet-scoped semantics: an unknown / third-party id is an error (-5).
    const missing = await rpcCall(server, "gettransaction", ["not-found"]);
    expect(missing.error?.code).toBe(-5);
    expect(Array.isArray((await rpcCall(server, "listtransactions", [10])).result)).toBe(true);
    const fees = await rpcCall(server, "estimatesmartfee");
    expect((fees.result as Record<string, unknown>).recommended).toBe("normal");
    server.stop();
  });

  test("serves peer and connection methods", async () => {
    const { server } = makeServer();
    const peers = await rpcCall(server, "getpeerinfo");
    expect((peers.result as unknown[]).length).toBe(1);
    expect((await rpcCall(server, "getconnectioncount")).result).toBe(1);
    server.stop();
  });

  test("serves signing and message methods", async () => {
    const { server } = makeServer();
    const signed = await rpcCall(server, "signrawtransactionwithwallet", ["00"]);
    expect((signed.result as Record<string, unknown>).complete).toBe(true);
    const msg = await rpcCall(server, "signmessage", [ADDRESS, "hello"]);
    expect((msg.result as string).length).toBe(128);
    expect((await rpcCall(server, "verifymessage", [ADDRESS, "0".repeat(128), "hello"])).result).toBe(true);
    const psbt = await rpcCall(server, "walletprocesspsbt", []);
    expect(psbt.error?.code).toBe(-32601);
    server.stop();
  });

  test("serves private key and wallet export methods", async () => {
    const { server } = makeServer();
    const priv = await rpcCall(server, "dumpprivkey", [ADDRESS]);
    expect((priv.result as string).length).toBe(64);
    const dump = await rpcCall(server, "dumpwallet", ["backup.txt"]);
    expect((dump.result as string)).toContain(ADDRESS);
    server.stop();
  });

  test("serves wallet password lifecycle methods", async () => {
    const { server } = makeServer();
    expect((await rpcCall(server, "walletpassphrase", ["secret", 60])).result).toBeNull();
    expect((await rpcCall(server, "walletlock")).result).toBeNull();
    const change = await rpcCall(server, "walletpassphrasechange", ["a", "b"]);
    expect(change.error?.code).toBe(-32601);
    const enc = await rpcCall(server, "encryptwallet", []);
    expect(enc.error?.code).toBe(-32601);
    server.stop();
  });

  test("serves balances and address methods", async () => {
    const { server } = makeServer();
    const balances = await rpcCall(server, "getbalances");
    expect((balances.result as Record<string, unknown>).mine).toBeDefined();
    expect((await rpcCall(server, "getwalletinfo")).result).toBeDefined();
    expect((await rpcCall(server, "getrawchangeaddress")).result).toBe(ADDRESS);
    const valid = await rpcCall(server, "validateaddress", [ADDRESS]);
    expect((valid.result as Record<string, unknown>).isvalid).toBe(true);
    expect((await rpcCall(server, "getaddressinfo", [ADDRESS])).result).toBeDefined();
    const unspent = await rpcCall(server, "listunspent", [0, 9999999, [ADDRESS]]);
    expect((unspent.result as unknown[]).length).toBe(1);
    expect((await rpcCall(server, "listsinceblock")).result).toBeDefined();
    expect((await rpcCall(server, "importaddress", [ADDRESS])).result).toBeNull();
    expect((await rpcCall(server, "importdescriptors", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "loadwallet", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "unloadwallet", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "createwallet", [])).error?.code).toBe(-32601);
    server.stop();
  });

  test("serves raw transaction methods", async () => {
    const { server } = makeServer();
    const raw = await rpcCall(server, "createrawtransaction", [[{ txid: "c".repeat(64), vout: 0 }], { [ADDRESS]: "10.00000000" }]);
    expect((raw.result as string)).toMatch(/^[0-9a-f]+$/);
    expect((await rpcCall(server, "fundrawtransaction", ["00"])).result).toBeDefined();
    const decoded = await rpcCall(server, "decoderawtransaction", ["00"]);
    expect((decoded.result as Record<string, unknown>).txid).toBe("d".repeat(64));
    expect((await rpcCall(server, "decodescript", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "sendrawtransaction", ["00"])).result).toBe("e".repeat(64));
    const mempool = await rpcCall(server, "testmempoolaccept", [["00"]]);
    expect((mempool.result as unknown[])[0]).toMatchObject({ allowed: true });
    expect((await rpcCall(server, "createpsbt", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "decodepsbt", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "combinepsbt", [])).error?.code).toBe(-32601);
    expect((await rpcCall(server, "finalizepsbt", [])).error?.code).toBe(-32601);
    server.stop();
  });

  test("serves mempool and utxo set methods", async () => {
    const { server } = makeServer();
    expect((await rpcCall(server, "gettxout", ["c".repeat(64), 0])).result).toBeDefined();
    expect((await rpcCall(server, "gettxoutsetinfo")).result).toBeDefined();
    const mempool = await rpcCall(server, "getrawmempool");
    expect(Array.isArray(mempool.result)).toBe(true);
    expect((await rpcCall(server, "getmempoolinfo")).result).toBeDefined();
    const entry = await rpcCall(server, "getmempoolentry", ["x".repeat(64)]);
    expect(entry.result).toBeDefined();
    // scantxoutset now scans arbitrary addresses instead of being rejected.
    const scan = await rpcCall(server, "scantxoutset", ["start", [`addr(${ADDRESS})`]]);
    expect((scan.result as Record<string, unknown>).success).toBe(true);
    expect((scan.result as Record<string, unknown>).txouts).toBe(1);
    // abort/status return the synchronous-scan state.
    expect(((await rpcCall(server, "scantxoutset", ["abort"])).result as Record<string, unknown>).success).toBe(false);
    // A missing action is a parameter error, not a method-not-found error.
    expect((await rpcCall(server, "scantxoutset", [])).error?.code).toBe(-32602);
    server.stop();
  });

  test("serves block chain methods", async () => {
    const { server } = makeServer();
    expect((await rpcCall(server, "getblockhash", [12])).result).toBe("b".repeat(64));
    expect((await rpcCall(server, "getblockhash", [99])).error?.code).toBe(-1);
    const header = await rpcCall(server, "getblockheader", ["b".repeat(64)]);
    expect((header.result as Record<string, unknown>).height).toBe(12);
    const block = await rpcCall(server, "getblock", ["b".repeat(64)]);
    expect((block.result as Record<string, unknown>).height).toBe(12);
    expect((await rpcCall(server, "getchaintips")).result).toBeDefined();
    // Non-verbose getrawtransaction returns the raw hex body.
    const rawTx = await rpcCall(server, "getrawtransaction", ["d".repeat(64)]);
    expect(rawTx.result).toBe("00");
    // Verbose=true returns the structured full-chain view with confirmations.
    const verbose = await rpcCall(server, "getrawtransaction", ["d".repeat(64), true]);
    const verboseResult = verbose.result as Record<string, unknown>;
    expect(verboseResult.txid).toBe("d".repeat(64));
    expect(verboseResult.confirmations).toBe(3);
    expect(verboseResult.in_active_chain).toBe(true);
    expect(Array.isArray(verboseResult.outputs)).toBe(true);
    server.stop();
  });

  test("serves network control methods", async () => {
    const { server } = makeServer();
    const network = await rpcCall(server, "getnetworkinfo");
    expect((network.result as Record<string, unknown>).subversion).toBe("/EDX:1.0/");
    expect((await rpcCall(server, "addnode", ["http://127.0.0.1:28332", "add"])).result).toBeNull();
    expect((await rpcCall(server, "addnode", ["http://127.0.0.1:28332", "remove"])).result).toBeNull();
    expect((await rpcCall(server, "addnode", ["http://127.0.0.1:28332", "bad"])).error).toBeDefined();
    expect((await rpcCall(server, "ping")).result).toBeNull();
    server.stop();
  });

  test("serves mining methods", async () => {
    const { server } = makeServer();
    const mining = await rpcCall(server, "getmininginfo");
    expect((mining.result as Record<string, unknown>).blocks).toBe(12);
    expect((await rpcCall(server, "getnetworkhashps")).result).toBe(66_667);
    const job = await rpcCall(server, "getminingjob");
    expect((job.result as Record<string, unknown>).jobId).toBeDefined();
    expect((await rpcCall(server, "getminingstats")).result).toBeDefined();
    expect((await rpcCall(server, "startmining")).result).toBe("mining started");
    expect((await rpcCall(server, "stopmining")).result).toBe("mining stopped");
    const template = await rpcCall(server, "getblocktemplate");
    expect((template.result as Record<string, unknown>).height).toBe(12);
    expect((await rpcCall(server, "generatetoaddress", [])).error?.code).toBe(-32601);
    server.stop();
  });

  test("submitblock decodes and forwards to the node consensus pipeline", async () => {
    const { server } = makeServer();
    // A structurally valid block body (difficulty as string on the wire).
    const blockJson: Block = {
      header: {
        version: 1,
        height: 13,
        previousHash: "b".repeat(64),
        timestampSeconds: 1_767_225_900,
        difficulty: GENESIS_BLOCK.header.difficulty,
        merkleRoot: "0".repeat(64),
        powSeed: "f".repeat(64),
        payoutAddress: ADDRESS,
      },
      hash: "9".repeat(64),
      nonce: 1,
      coinbase: { outputs: [{ address: ADDRESS, amount: "400.00000000" }] },
      transactions: [],
    };
    const wire = Buffer.from(
      JSON.stringify(blockJson, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      "utf8",
    ).toString("hex");
    const accepted = await rpcCall(server, "submitblock", [wire]);
    expect(accepted.result).toBeNull(); // extended -> bitcoind null success

    const garbage = await rpcCall(server, "submitblock", ["deadbeef"]);
    expect(garbage.result).toBe("unknown");
    server.stop();
  });

  test("submitblock reports duplicate and rejection states", async () => {
    const conn = fakeConn({
      "/blocks": undefined,
    });
    // Override the POST /blocks route per-case by wrapping request.
    const base = fakeConn();
    const connDup = {
      request: async (method: "GET" | "POST", path: string) => {
        if (method === "POST" && path === "/blocks") return { result: "known" };
        return base.request(method, path);
      },
    } as unknown as ConnectionManager;
    const server = new WalletRpcServer(createConfig() as never, stubCore(connDup), {} as never);
    const blockJson: Block = {
      header: {
        version: 1,
        height: 13,
        previousHash: "b".repeat(64),
        timestampSeconds: 1_767_225_900,
        difficulty: GENESIS_BLOCK.header.difficulty,
        merkleRoot: "0".repeat(64),
        powSeed: "f".repeat(64),
        payoutAddress: ADDRESS,
      },
      hash: "9".repeat(64),
      nonce: 1,
      coinbase: { outputs: [{ address: ADDRESS, amount: "400.00000000" }] },
      transactions: [],
    };
    const wire = Buffer.from(
      JSON.stringify(blockJson, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      "utf8",
    ).toString("hex");
    const duplicate = await rpcCall(server, "submitblock", [wire]);
    expect(duplicate.result).toBe("duplicate");
    server.stop();

    const connRejected = {
      request: async (method: "GET" | "POST", path: string) => {
        if (method === "POST" && path === "/blocks") throw new Error("merkle root mismatch");
        return base.request(method, path);
      },
    } as unknown as ConnectionManager;
    const server2 = new WalletRpcServer(createConfig() as never, stubCore(connRejected), {} as never);
    const rejected = await rpcCall(server2, "submitblock", [wire]);
    expect((rejected.result as Record<string, unknown>).status).toBe("rejected");
    expect((rejected.result as Record<string, unknown>).reject_reason).toContain("merkle root mismatch");
    server2.stop();
  });

  test("unknown methods and invalid parameters are rejected with bitcoind codes", async () => {
    const { server } = makeServer();
    const missing = await rpcCall(server, "nosuchmethod");
    expect(missing.error?.code).toBe(-32601);
    const badParams = await rpcCall(server, "getblockhash", ["not-a-number"]);
    expect(badParams.error?.code).toBe(-32602);
    const badCount = await rpcCall(server, "sendtoaddress", [ADDRESS]);
    expect(badCount.error?.code).toBe(-32602);
    server.stop();
  });

  test("stop schedules a graceful shutdown", async () => {
    const { server } = makeServer();
    const stopped = await rpcCall(server, "stop");
    expect(stopped.result).toBe("stopping");
    server.stop();
  });
});

// Keep EDX referenced so the constant is not flagged unused.
void EDX;
