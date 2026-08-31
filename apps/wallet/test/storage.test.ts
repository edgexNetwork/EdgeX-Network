import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  EDX_UNIT,
  addressFromPublicKey,
  generateKeyPair,
  signTransaction,
  transactionId,
} from "@edgex/shared";
import type { SignedTransaction } from "@edgex/shared";
import { GENESIS_BLOCK, coinbaseId } from "@edgex/core";
import type { Block, CoinbaseTransaction } from "@edgex/core";
import { initGlobalData, readGlobalData, writeGlobalData } from "../src/core/globalData";
import {
  ChainDataError,
  ChainStore,
  LEGACY_DB_NEEDS_MIGRATION,
  chainLinkageError,
  isLegacyEncryptedChainDb,
} from "../src/core/walletDatabase";

const ZEROS64 = "0".repeat(64);
const aliceKey = generateKeyPair();
const ALICE = addressFromPublicKey(aliceKey.publicKeyHex);
const BOB = addressFromPublicKey(generateKeyPair().publicKeyHex);

function hashOf(height: number): string {
  return `hash-${String(height).padStart(6, "0")}`;
}

/** Builds a block (bare by default: no coinbase, no transactions; mining outputs or transfers can be injected). */
function block(
  height: number,
  prevHash: string,
  opts: { coinbase?: Array<{ address: string; amount: string }>; transactions?: SignedTransaction[] } = {},
): Block {
  return {
    header: {
      version: 1,
      height,
      previousHash: prevHash,
      timestampSeconds: GENESIS_BLOCK.header.timestampSeconds + height * 15,
      difficulty: GENESIS_BLOCK.header.difficulty,
      merkleRoot: ZEROS64,
      powSeed: GENESIS_BLOCK.header.powSeed,
      payoutAddress: opts.coinbase?.[0]?.address ?? "",
    },
    hash: hashOf(height),
    nonce: height,
    coinbase: opts.coinbase && opts.coinbase.length > 0 ? { outputs: opts.coinbase } : null,
    transactions: opts.transactions ?? [],
  };
}

function makeChain(n: number): Block[] {
  const blocks: Block[] = [];
  for (let h = 0; h < n; h++) blocks.push(block(h, h === 0 ? ZEROS64 : hashOf(h - 1)));
  return blocks;
}

/** Mining block: mints an amount (EDX) reward to address, returns the coinbase transaction txid (for later spend references). */
function minedBlock(height: number, prevHash: string, address: string, amount: string): { block: Block; txid: string } {
  const coinbase: CoinbaseTransaction = { outputs: [{ address, amount }] };
  return { block: block(height, prevHash, { coinbase: coinbase.outputs }), txid: coinbaseId(height, coinbase) };
}

/** Builds a real signed transfer (spends a mining output, pays outputs, fee counted as an expense). */
function spendTx(
  inputTxid: string,
  inputIndex: number,
  outputs: Array<{ address: string; amount: string }>,
  fee: string,
): SignedTransaction {
  return signTransaction(
    {
      inputs: [{ txid: inputTxid, index: inputIndex }],
      outputs,
      fee,
    },
    aliceKey.privateKeyHex,
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "edgex-chainstore-"));
});
afterEach(() => {
  // On-disk database handles release slowly on Windows: retry rm to avoid false EBUSY reports
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("旧版加密库识别与清理提示", () => {
  test("EDXCHDB 文件头识别：isLegacyEncryptedChainDb 为 true，open() 报清理提示（walletCore 启动时会删除重建）", () => {
    const file = path.join(dir, "chain.db");
    writeFileSync(file, Buffer.concat([Buffer.from("EDXCHDB", "ascii"), Buffer.from([1]), Buffer.alloc(64)]));
    expect(isLegacyEncryptedChainDb(file)).toBe(true);
    const store = new ChainStore(file);
    const res = store.open();
    expect(res.ok).toBe(false);
    expect(res.error).toBe(LEGACY_DB_NEEDS_MIGRATION);
    store.close();
  });

  test("明文磁盘库不是旧版加密格式（isLegacyEncryptedChainDb 为 false）", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file);
    store.open();
    store.appendBlocks(makeChain(3));
    store.close();
    expect(isLegacyEncryptedChainDb(file)).toBe(false);
  });
});

describe("chainStore 打开/追加/持久化（磁盘明文库）", () => {
  test("新建空库：ok 且 existed=false，高度 -1", () => {
    const store = new ChainStore(path.join(dir, "chain.db"));
    const res = store.open();
    expect(res.ok).toBe(true);
    expect(res.existed).toBe(false);
    expect(store.localHeight()).toBe(-1);
    store.close();
  });

  test("追加区块后关闭即持久化（磁盘库自动落盘，无需显式 save）：重开数据完整且完整性校验通过", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file);
    store.open();
    expect(store.appendBlocks(makeChain(50))).toBe(50);
    store.close();

    const store2 = new ChainStore(file);
    const res = store2.open();
    expect(res.ok).toBe(true);
    expect(store2.localHeight()).toBe(49);
    expect(store2.genesisHash()).toBe(hashOf(0));
    expect(store2.integrityCheck()).toBeNull();
    store2.close();
  });

  test("篡改区块 hash 后重开 → 区块数据错误（链式校验检测外部篡改）", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file);
    store.open();
    store.appendBlocks(makeChain(10));
    store.close();

    // A plaintext disk database can be tampered with directly: changing the genesis hash makes it inconsistent with the meta record
    const db = new Database(file);
    db.run("UPDATE blocks SET hash = 'tampered' WHERE height = 0");
    db.close();

    const store2 = new ChainStore(file);
    const res = store2.open();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Blockchain data error");
    expect(res.error).toContain("genesis");
    store2.close();
  });

  test("跳档追加（缺前驱）抛 ChainDataError", () => {
    const store = new ChainStore(path.join(dir, "chain.db"));
    store.open();
    store.appendBlocks(makeChain(5)); // 0..4
    expect(() => store.appendBlocks([block(10, hashOf(9))])).toThrow(ChainDataError);
    expect(() => store.appendBlocks([block(10, hashOf(9))])).toThrow(/missing its predecessor/);
    store.close();
  });

  test("prevHash 不匹配追加抛 ChainDataError", () => {
    const store = new ChainStore(path.join(dir, "chain.db"));
    store.open();
    store.appendBlocks(makeChain(5));
    expect(() => store.appendBlocks([block(5, "wrong-prev")])).toThrow(ChainDataError);
    expect(() => store.appendBlocks([block(5, "wrong-prev")])).toThrow(/prevHash mismatch/);
    store.close();
  });

  test("重复追加幂等（跳过已有高度）", () => {
    const store = new ChainStore(path.join(dir, "chain.db"));
    store.open();
    store.appendBlocks(makeChain(10));
    expect(store.appendBlocks(makeChain(10))).toBe(0);
    expect(store.localHeight()).toBe(9);
    store.close();
  });

  test("rebuild 清空并重建空的磁盘库文件", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file);
    store.open();
    store.appendBlocks(makeChain(10));
    store.rebuild();
    expect(store.localHeight()).toBe(-1);
    // Disk database mode: rebuild immediately recreates an empty database file (no need to wait for the next flush)
    expect(store.exists()).toBe(true);
    store.close();
  });
});

describe("chainStore 交易索引（挖矿奖励成熟 + 转账去重反查）", () => {
  test("挖矿奖励：coinbase 输出成 mining UTXO，成熟高度 = 块高 + COINBASE_MATURITY，未成熟不可花", () => {
    const store = new ChainStore(path.join(dir, "chain.db"), ALICE);
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    expect(store.appendBlocks([genesis, b1])).toBe(2);
    store.close();
    // After reopening (own view persisted): balance includes the immature reward, and immature amount is judged against the current height
    const store2 = new ChainStore(path.join(dir, "chain.db"), ALICE);
    expect(store2.open().ok).toBe(true);
    expect(store2.addressBalance(ALICE)).toBe(100n * EDX_UNIT);
    expect(store2.addressImmature(ALICE, 1)).toBe(100n * EDX_UNIT);
    expect(store2.addressImmature(ALICE, 7)).toBe(0n);
    expect(store2.addressUtxos(ALICE, 1)).toHaveLength(0);
    const utxos = store2.addressUtxos(ALICE, 7);
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.txid).toBe(txid);
    // edgex amount display convention: formatEdxAmount strips trailing zeros
    expect(utxos[0]!.amount).toBe("100");
    expect(utxos[0]!.matureAtHeight).toBe(7);
    expect(store2.isConfirmedTx(txid)).toBe(true);
    const detail = store2.getLocalTx(txid)!;
    expect(detail.type).toBe("mining");
    expect(detail.outputs[0]!.address).toBe(ALICE);
    store2.close();
  });

  test("转账索引：花费挖矿输出 → 输出成 UTXO、输入标记花费、地址映射、余额/历史/详情派生", () => {
    const store = new ChainStore(path.join(dir, "chain.db"), ALICE);
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid: fundingTxid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    const spend = spendTx(
      fundingTxid,
      0,
      [
        { address: BOB, amount: "30.00000000" },
        { address: ALICE, amount: "69.99000000" },
      ],
      "0.01",
    );
    const spendTxid = transactionId(spend);
    const b2 = block(2, b1.hash, { transactions: [spend] });
    expect(store.appendBlocks([genesis, b1, b2])).toBe(3);

    // Balance: A has confirmed unspent = change 69.99; B = 30
    expect(store.addressBalance(ALICE)).toBe(6999000000n);
    expect(store.addressBalance(BOB)).toBe(3000000000n);
    // Spendable UTXOs (mature; the mining output has already been spent)
    const utxos = store.addressUtxos(ALICE, 2);
    expect(utxos.length).toBe(1);
    expect(utxos[0]!.txid).toBe(spendTxid);
    // edgex amount display convention: formatEdxAmount strips trailing zeros
    expect(utxos[0]!.amount).toBe("69.99");
    expect(utxos[0]!.spentTxid).toBeNull();
    // Address transaction history (own_txs view)
    const aliceTxs = store.addressTxids(ALICE, 20);
    expect(aliceTxs.map((t) => t.txid).sort()).toEqual([fundingTxid, spendTxid].sort());
    // Transaction detail (deduped lookups): inputs/outputs/status/block height
    const detail = store.getLocalTx(spendTxid)!;
    expect(detail.inputs).toHaveLength(1);
    expect(detail.inputs[0]!.txid).toBe(fundingTxid);
    expect(detail.outputs).toHaveLength(2);
    expect(detail.status).toBe("confirmed");
    expect(detail.blockHeight).toBe(2);
    expect(store.isConfirmedTx(spendTxid)).toBe(true);
    store.close();
  });

  test("跨块花费：输入引用上一块输出时 spent 标记（含 spent_idx）同步到 tx_outputs 与 own_utxos", () => {
    const store = new ChainStore(path.join(dir, "chain.db"), ALICE);
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid: fundingTxid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    const spend = spendTx(fundingTxid, 0, [{ address: BOB, amount: "99.99000000" }], "0.01");
    const b2 = block(2, b1.hash, { transactions: [spend] });
    store.appendBlocks([genesis, b1, b2]);
    expect(store.addressBalance(ALICE)).toBe(0n);
    expect(store.addressBalance(BOB)).toBe(9999000000n);
    expect(store.addressUtxos(ALICE, 2)).toHaveLength(0);
    store.close();
  });

  test("truncate 链回退：删除区块+交易+索引，恢复被回滚交易花费的输出（含 spent_idx 清空）", () => {
    const store = new ChainStore(path.join(dir, "chain.db"));
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid: fundingTxid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    const spend = spendTx(fundingTxid, 0, [{ address: BOB, amount: "99.99000000" }], "0.01");
    const spendTxid = transactionId(spend);
    const b2 = block(2, b1.hash, { transactions: [spend] });
    store.appendBlocks([genesis, b1, b2]);
    expect(store.addressBalance(ALICE)).toBe(0n);
    expect(store.addressBalance(BOB)).toBe(9999000000n);

    // Roll back to height 1: block 2 deleted, the mining output restored to unspent, B's balance back to zero
    const removed = store.truncate(1);
    expect(removed).toBe(1);
    expect(store.localHeight()).toBe(1);
    expect(store.addressBalance(ALICE)).toBe(10000000000n);
    expect(store.addressBalance(BOB)).toBe(0n);
    expect(store.getLocalTx(spendTxid)).toBeNull();
    expect(store.isConfirmedTx(spendTxid)).toBe(false);
    store.close();
  });

  test("outbox：写入/列表/状态更新/锁定与释放输入（spent_idx 随锁定/解锁同步）", () => {
    const store = new ChainStore(path.join(dir, "chain.db"), ALICE);
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid: fundingTxid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    store.appendBlocks([genesis, b1]);
    expect(store.addressBalance(ALICE)).toBe(10000000000n);

    // After a pending transaction locks its inputs the balance is unavailable (prevents double-spending)
    store.lockOutboxInputs("out-tx", [{ txid: fundingTxid, index: 0 }]);
    expect(store.addressBalance(ALICE)).toBe(0n);
    expect(store.addressUtxos(ALICE, 7)).toHaveLength(0);

    // Outbox write and status transitions
    const payload = {
      inputs: [{ txid: fundingTxid, index: 0 }],
      outputs: [{ address: BOB, amount: "99.99000000" }],
      fee: "0.01",
    };
    const now = Date.now();
    store.upsertOutbox({ txid: "out-tx", payload, status: "pending", attempts: 0, lastError: null, createdAt: now, updatedAt: now });
    const entries = store.listOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("pending");
    store.updateOutboxStatus("out-tx", { status: "broadcast" });
    expect(store.listOutbox()[0]!.status).toBe("broadcast");
    // Before confirmation, getLocalTx returns pending details (input addresses/amounts resolved from local UTXOs)
    const detail = store.getLocalTx("out-tx")!;
    expect(detail.status).toBe("pending");
    expect(detail.inputs[0]!.txid).toBe(fundingTxid);
    expect(detail.inputs[0]!.address).toBe(ALICE);
    // Release the lock
    store.unlockOutboxInputs("out-tx");
    expect(store.addressBalance(ALICE)).toBe(10000000000n);
    store.deleteOutbox("out-tx");
    expect(store.listOutbox()).toHaveLength(0);
    store.close();
  });
});

describe("钱包视图 own_*（本钱包地址走 own_txs/own_utxos，其他地址走全量）", () => {
  test("own 视图余额/UTXO/历史 + 锁定/解锁/回滚同步", () => {
    const store = new ChainStore(path.join(dir, "chain.db"), ALICE);
    store.open();
    const genesis = block(0, ZEROS64);
    const { block: b1, txid: fundingTxid } = minedBlock(1, genesis.hash, ALICE, "100.00000000");
    const spend = spendTx(
      fundingTxid,
      0,
      [
        { address: BOB, amount: "30.00000000" },
        { address: ALICE, amount: "69.99000000" },
      ],
      "0.01",
    );
    const spendTxid = transactionId(spend);
    store.appendBlocks([genesis, b1, block(2, b1.hash, { transactions: [spend] })]);
    // own view: ALICE balance = change 69.99; 1 UTXO; 2 history entries
    expect(store.addressBalance(ALICE)).toBe(6999000000n);
    expect(store.addressUtxos(ALICE, 2)).toHaveLength(1);
    expect(store.addressTxids(ALICE, 20).map((t) => t.txid).sort()).toEqual([fundingTxid, spendTxid].sort());
    // Other addresses (BOB): still use the full index
    expect(store.addressBalance(BOB)).toBe(3000000000n);
    expect(store.addressTxids(BOB, 20).map((t) => t.txid)).toEqual([spendTxid]);
    // Lock/unlock syncs own_utxos
    store.lockOutboxInputs("out-tx", [{ txid: spendTxid, index: 1 }]);
    expect(store.addressBalance(ALICE)).toBe(0n);
    store.unlockOutboxInputs("out-tx");
    expect(store.addressBalance(ALICE)).toBe(6999000000n);
    // Chain rollback syncs own_* (before rolling back to height 1: all transactions of blocks 1/2 deleted, ALICE balance restored to 0)
    store.truncate(0);
    expect(store.addressBalance(ALICE)).toBe(0n);
    expect(store.addressTxids(ALICE, 20)).toHaveLength(0);
    store.close();
  });
});

describe("分段归档与跨段读取", () => {
  /** 2000-block chain; blocks 1/2 carry mining/spend transactions (ALICE receives 100 → spends 100 to BOB 30 + change 69.99). */
  function archivableChain(): { chain: Block[]; fundingTxid: string; spendTxid: string } {
    const chain = makeChain(2000);
    const { block: b1, txid: fundingTxid } = minedBlock(1, chain[0]!.hash, ALICE, "100.00000000");
    const spend = spendTx(
      fundingTxid,
      0,
      [
        { address: BOB, amount: "30.00000000" },
        { address: ALICE, amount: "69.99000000" },
      ],
      "0.01",
    );
    const spendTxid = transactionId(spend);
    chain[1] = b1;
    chain[2] = block(2, b1.hash, { transactions: [spend] });
    return { chain, fundingTxid, spendTxid };
  }

  test("封段：活跃库超阈值 → 固化为压缩段 + 段注册 + 清空旧数据（保留锚点）+ 重开幂等", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file, ALICE, 64 * 1024); // 64KB small threshold triggers segmenting
    store.open();
    const { chain } = archivableChain();
    store.appendBlocks(chain);
    expect(store.localHeight()).toBe(1999);
    expect(store.segmentCount).toBeGreaterThanOrEqual(1);
    const segs = store.segmentIndex();
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[segs.length - 1]!.end).toBe(1999);
    // The compressed segment file was created
    const filePath = path.join(dir, "archive", segs[segs.length - 1]!.file);
    expect(existsSync(filePath)).toBe(true);
    // Active database keeps the anchor row + own_* resident: linkage check passes (non-zero start), balance uses the own view
    expect(store.integrityCheck()).toBeNull();
    expect(store.addressBalance(ALICE)).toBe(6999000000n);
    // Any-address (BOB) cross-segment merge is correct
    expect(store.addressBalance(BOB)).toBe(3000000000n);
    // Reopen: segment registration does not duplicate, height/integrity preserved
    store.close();
    const store2 = new ChainStore(file, ALICE, 64 * 1024);
    const res = store2.open();
    expect(res.ok).toBe(true);
    expect(store2.localHeight()).toBe(1999);
    expect(store2.segmentCount).toBe(segs.length);
    expect(store2.integrityCheck()).toBeNull();
    store2.close();
  });

  test("跨段读取：老交易详情跨段反查，排序与花费引用归并正确", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file, ALICE, 64 * 1024);
    store.open();
    const { chain, fundingTxid, spendTxid } = archivableChain();
    store.appendBlocks(chain);
    // Old transactions (archived segment 0..1999) can still be resolved
    const detail = store.getLocalTx(spendTxid)!;
    expect(detail.status).toBe("confirmed");
    expect(detail.blockHeight).toBe(2);
    expect(detail.inputs[0]!.txid).toBe(fundingTxid);
    expect(detail.outputs).toHaveLength(2);
    expect(detail.outputs[0]!.address).toBe(BOB);
    // Non-wallet-address history merged across segments (BOB participates in a single transaction)
    const bobTxs = store.addressTxids(BOB, 20);
    expect(bobTxs.map((t) => t.txid)).toEqual([spendTxid]);
    // own view history (resident in the active database, no cross-segment reads)
    const aliceTxs = store.addressTxids(ALICE, 20);
    expect(aliceTxs.map((t) => t.txid).sort()).toEqual([fundingTxid, spendTxid].sort());
    store.close();
  });

  test("封段后继续追加：锚点衔接通过，本地高度持续增长，可再封第二段", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file, ALICE, 64 * 1024);
    store.open();
    const { chain, spendTxid } = archivableChain();
    store.appendBlocks(chain); // segment 1: 0..1999
    // Appending new blocks (predecessor 1999 anchor kept in the active database) → linkage check passes
    expect(store.appendBlocks(makeChain(2300).slice(2000))).toBe(300);
    expect(store.localHeight()).toBe(2299);
    expect(store.integrityCheck()).toBeNull();
    // Active database exceeds the threshold again, sealing a second segment
    const segs = store.segmentIndex();
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[segs.length - 1]!.start).toBe(2000);
    expect(segs[segs.length - 1]!.end).toBe(2299);
    // After the second segment is registered, reopening stays intact; old transactions remain resolvable across segments
    store.close();
    const store2 = new ChainStore(file, ALICE, 64 * 1024);
    expect(store2.open().ok).toBe(true);
    expect(store2.localHeight()).toBe(2299);
    expect(store2.integrityCheck()).toBeNull();
    expect(store2.getLocalTx(spendTxid)!.blockHeight).toBe(2);
    store2.close();
  });

  test("rebuild 删除本地库与全部归档段", () => {
    const file = path.join(dir, "chain.db");
    const store = new ChainStore(file, ALICE, 64 * 1024);
    store.open();
    const { chain } = archivableChain();
    store.appendBlocks(chain);
    expect(store.segmentCount).toBeGreaterThanOrEqual(1);
    store.rebuild();
    expect(store.segmentCount).toBe(0);
    expect(store.exists()).toBe(true); // rebuilt empty database file (disk database mode)
    expect(existsSync(path.join(dir, "archive"))).toBe(false);
    store.close();
  });
});

describe("chainLinkageError 纯函数", () => {
  test("完好链返回 null", () => {
    const rows = makeChain(10).map((b) => ({ height: b.header.height, hash: b.hash, prevHash: b.header.previousHash }));
    expect(chainLinkageError(rows, hashOf(0))).toBeNull();
  });

  test("缺块（gap）报错", () => {
    const rows = [
      { height: 0, hash: "h0", prevHash: ZEROS64 },
      { height: 2, hash: "h2", prevHash: "h0" },
    ];
    expect(chainLinkageError(rows, "h0")).toContain("gap at height 1");
  });

  test("prevHash 断裂报错", () => {
    const rows = [
      { height: 0, hash: "h0", prevHash: ZEROS64 },
      { height: 1, hash: "h1", prevHash: "bad" },
    ];
    expect(chainLinkageError(rows, "h0")).toContain("does not link");
  });

  test("genesis hash 与记录的创世哈希不一致报错", () => {
    const rows = [{ height: 0, hash: "h0", prevHash: ZEROS64 }];
    expect(chainLinkageError(rows, "other")).toContain("genesis hash mismatch");
  });

  test("genesis prevHash 非空且非协议创世（64 零）报错", () => {
    const rows = [{ height: 0, hash: "h0", prevHash: "x" }];
    expect(chainLinkageError(rows, "h0")).toContain("non-empty prevHash");
  });
});

describe("machine-wide global data（加密 KV，不在本次链库格式优化范围，保持加密）", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "edgex-global-"));
  test("creates an encrypted database and persists safe preferences", () => {
    const created = initGlobalData(directory);
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);
    writeGlobalData("test.value", "kept");
    expect(readGlobalData("test.value")).toBe("kept");
    expect(initGlobalData(directory).created).toBe(false);
    expect(readGlobalData("test.value")).toBe("kept");
  });
  afterAll(() => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(directory, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
});