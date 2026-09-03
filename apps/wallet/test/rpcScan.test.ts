import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_MAX_SEGMENT_BYTES, type WalletConfig } from "../src/config/config";
import { WalletCore } from "../src/core/walletCore";
import type { ConnectionManager } from "../src/core/connection";
import { deriveWalletKey } from "../src/keys/walletKeyClean";
import { bytesToHex } from "@edgex/shared";

/**
 * RPC scan tests: the wallet-core scan and verbose-lookup methods are exercised
 * against a stubbed node connection, so no service needs to run. The node REST
 * contract (wallet UTXOs per address, transaction lookup by id, chain info) is
 * served with canned records.
 */

const OWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A second address that appears on the chain but belongs to a different wallet
// (BIP44 root path m/44'/778'/0'/0, the same root the wallet derives from).
const FOREIGN_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);

const directory = mkdtempSync(join(tmpdir(), "edgex-rpc-scan-"));

/** A node REST stub keyed by URL path; POST /transactions is never reached here. */
function fakeConnFor(
  ownAddress: string,
  foreignAddress: string,
  ownUtxos: unknown[],
  foreignUtxos: unknown[],
): ConnectionManager {
  const routes: Record<string, unknown> = {
    "/chain/info": {
      height: 12,
      bestHash: "b".repeat(64),
      totalIssued: "4800.00000000",
      mempoolSize: 0,
      difficulty: "1000000",
      networkHashps: 66_667,
      networkPower: 66_667,
      genesisHash: "g".repeat(64),
    },
    [`/wallet/utxos?address=${encodeURIComponent(ownAddress)}`]: { items: ownUtxos },
    [`/wallet/utxos?address=${encodeURIComponent(foreignAddress)}`]: { items: foreignUtxos },
    [`/transactions/${TXID_A}`]: {
      txid: TXID_A,
      type: "transfer",
      category: "send",
      amount: "10.00000000",
      fee: "0.00010000",
      status: "confirmed",
      confirmations: 3,
      matureAtHeight: null,
      height: 9,
      time: 1_767_225_700,
      from: ownAddress,
      inputs: [{ txid: TXID_B, index: 0, address: ownAddress, amount: "10.00010000" }],
      outputs: [{ address: ownAddress, amount: "0.00000000", isChange: true }],
    },
    [`/transactions/${TXID_B}`]: {
      txid: TXID_B,
      type: "transfer",
      category: "receive",
      amount: "10.00000000",
      fee: "0.00010000",
      status: "confirmed",
      confirmations: 12,
      matureAtHeight: null,
      height: 0,
      time: 1_767_225_000,
      from: foreignAddress,
      inputs: [],
      outputs: [{ address: foreignAddress, amount: "10.00000000", isChange: false }],
    },
  };
  return {
    request: async (method: "GET" | "POST", path: string) => {
      const hit = routes[path];
      if (hit !== undefined) return hit;
      // An unknown transaction id maps to the node answering null (not found).
      if (method === "GET" && path.startsWith("/transactions/")) return null;
      throw new Error(`unexpected node request: ${method} ${path}`);
    },
  } as unknown as ConnectionManager;
}

function createConfig(datadir: string, nodeUrl: string): WalletConfig {
  return {
    datadir,
    confPath: join(datadir, "dexcoin.conf"),
    server: false,
    rpcuser: "edx",
    rpcpassword: "edx-secret",
    listen: false,
    addnodes: [],
    nodeUrl,
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

/** A test double for the logging dependency. */
const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as never;

describe("chain-wide UTXO scan and verbose transaction lookup", () => {
  let core: WalletCore;
  let ownKey: ReturnType<typeof deriveWalletKey>;
  let foreignAddress: string;

  beforeAll(() => {
    // The wallet key is derived from a fixed mnemonic so the address is
    // deterministic. A second key (different mnemonic) plays the third party
    // whose chain activity must be invisible to wallet-scoped methods.
    ownKey = deriveWalletKey(OWN_MNEMONIC);
    foreignAddress = deriveWalletKey(FOREIGN_MNEMONIC).address;
    const config = createConfig(directory, "http://127.0.0.1:28332");
    const own = ownKey.address;
    const ownUtxos = [
      { txid: TXID_A, index: 0, address: own, amount: "10.00000000", birthHeight: 9, isCoinbase: false, spendable: true },
    ];
    const foreignUtxos = [
      { txid: TXID_B, index: 0, address: foreignAddress, amount: "10.00000000", birthHeight: 0, isCoinbase: true, spendable: true },
    ];
    core = new WalletCore(
      config,
      {
        mnemonic: ownKey.mnemonic,
        derivationPath: ownKey.derivationPath,
        privateKey: new Uint8Array(Buffer.from(bytesToHex(ownKey.privateKey), "hex")),
        publicKey: new Uint8Array(Buffer.from(bytesToHex(ownKey.publicKey), "hex")),
        address: own,
      },
      silentLog,
    );
    // Swap the real connection manager and chain database for the canned route
    // stub (the wallet core never starts its timers in this test, so nothing
    // reaches the network). The production fields are readonly, so a mutable
    // test alias is used.
    const mutable = core as unknown as {
      conn: ConnectionManager;
      database: { isOpen: boolean; blockAt(height: number): { hash: string } | null };
    };
    mutable.conn = fakeConnFor(own, foreignAddress, ownUtxos, foreignUtxos);
    // The chain database stays closed in this test; verbose lookup reports a
    // null block hash instead of resolving one from the local store.
    mutable.database = { isOpen: false, blockAt: () => null };
    // The scan computes confirmations against the synced chain tip; seed the
    // local chain state so height-based confirmations are deterministic.
    core.chain.update({
      height: 12,
      latestHash: "b".repeat(64),
      connectedNodes: 1,
    });
    core.chain.setSync({ syncStatus: "synced" });
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("scanTxOutSet resolves addr(<address>) descriptors and maps node UTXOs", async () => {
    const result = await core.scanTxOutSet([`addr(${ownKey.address})`]);
    expect(result.success).toBe(true);
    expect(result.txouts).toBe(1);
    // Amounts travel as canonical EDX strings (parseable, not fixed-width).
    expect(result.total_amount).toBe("10");
    expect(result.unspents[0]).toMatchObject({
      txid: TXID_A,
      vout: 0,
      address: ownKey.address,
      amount: "10.00000000",
      scriptPubKey: "",
    });
    // The node reports birth height 9; the synced chain tip is 12, so the
    // confirmation count is 12 - 9 + 1 = 4.
    expect(result.unspents[0]?.confirmations).toBe(4);
  });

  test("scanTxOutSet accepts a bare address and scans foreign addresses too", async () => {
    const result = await core.scanTxOutSet([foreignAddress]);
    expect(result.success).toBe(true);
    expect(result.txouts).toBe(1);
    expect(result.unspents[0]?.address).toBe(foreignAddress);
    expect(result.unspents[0]?.confirmations).toBe(13);
  });

  test("scanTxOutSet rejects an unknown action and empty descriptor lists", async () => {
    await expect(core.scanTxOutSet([])).rejects.toMatchObject({ code: -32602 });
    await expect(core.scanTxOutSet(["not-an-address"])).rejects.toMatchObject({ code: -32602 });
    await expect(core.scanTxOutSet(["raw(x)"])).rejects.toMatchObject({ code: -32602 });
  });

  test("getRawTransactionVerbose returns a structured full-chain view", async () => {
    const verbose = await core.getRawTransactionVerbose(TXID_A);
    expect(verbose).not.toBeNull();
    expect(verbose!.txid).toBe(TXID_A);
    expect(verbose!.confirmations).toBe(3);
    expect(verbose!.in_active_chain).toBe(true);
    // The node record carries no signature, so the hex body covers inputs,
    // outputs and fee only.
    expect(verbose!.hex).toMatch(/^[0-9a-f]+$/);
    expect(verbose!.inputs).toEqual([{ txid: TXID_B, vout: 0, address: ownKey.address, amount: "10.00010000" }]);
    expect(verbose!.outputs.length).toBeGreaterThan(0);
    // The local chain database is closed in this test, so the block hash stays null.
    expect(verbose!.blockhash).toBeNull();
    expect(await core.getRawTransactionVerbose("f".repeat(64))).toBeNull();
  });

  test("getTransaction is wallet-scoped: a third-party transaction is invisible", async () => {
    // TXID_B pays the foreign address (not this wallet): gettransaction must hide it.
    expect(await core.getTransaction(TXID_B)).toBeNull();
    // getRawTransactionVerbose still sees it (full-chain lookup).
    expect(await core.getRawTransactionVerbose(TXID_B)).not.toBeNull();
  });
});
