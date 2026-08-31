import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { COINBASE_MATURITY, addressFromPublicKey, formatEdxAmount, parseEdxAmount, transactionId } from "@edgex/shared";
import { coinbaseId } from "@edgex/core";
import type { Block } from "@edgex/core";
import { DEFAULT_MAX_SEGMENT_BYTES } from "../config/config";

/**
 * Local chain database: bun:sqlite on-disk database (plaintext, incremental persistence, WAL crash recovery).
 * Holds public chain data + payment records for this wallet's addresses; private keys/mnemonics are never
 * stored here (they live in wallet.vault, protected by the wallet password). Integrity is enforced by the
 * chained linkage check (integrityCheck) and segment boundary checks.
 *
 * Older versions used "in-memory sqlite + whole-file AES-256-GCM encryption" (magic EDXCHDB, key bound to
 * the wallet private key). Migration cost grows linearly with database size, so such files are detected,
 * deleted and fully re-synced instead (done by walletCore at startup).
 */
export const CHAIN_DB_MAGIC = "EDXCHDB";
/** Local database schema version (stored in meta; for future structure upgrades). */
export const CHAIN_DB_SCHEMA_VERSION = "3";
/** Error text returned by open() while a legacy encrypted database has not been cleaned up yet (walletCore deletes it on normal startup). */
export const LEGACY_DB_NEEDS_MIGRATION =
  "Blockchain data error: legacy encrypted database found; restart to delete and resync";

/** Chain database error (corrupted file / broken chain), always surfaced as "blockchain data error". */
export class ChainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainDataError";
  }
}

/** Lightweight rows for the linkage check (exported for pure-function tests). */
export interface ChainRowLite {
  height: number;
  hash: string;
  prevHash: string;
}

/**
 * Chained integrity check (pure function): no gaps from the segment start height onward, genesis check for the
 * first block (when at height 0), and each block's prevHash links to the previous block's hash. After segmented
 * archival the active database may start at a non-zero height (the previous segment's tail anchor row is kept),
 * so continuity is anchored at rows[0].height rather than a fixed 0.
 * The genesis prevHash accepts both the empty string and the protocol genesis (64 zeros).
 * Returns an error message; null on success.
 */
export function chainLinkageError(rows: ChainRowLite[], genesisHash: string | null): string | null {
  const start = rows.length > 0 ? rows[0].height : 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expected = start + i;
    if (r.height !== expected) {
      return `Blockchain data error: local chain has a gap at height ${expected} (found height ${r.height})`;
    }
    if (i === 0) {
      // Run the genesis check only when the segment starts at the genesis block; after archival the first block's prevHash is guaranteed by segment boundary linkage
      if (r.height === 0) {
        const zeros = "0".repeat(64);
        if (r.prevHash !== "" && r.prevHash !== zeros) {
          return "Blockchain data error: genesis block has a non-empty prevHash";
        }
        if (genesisHash && r.hash !== genesisHash) {
          return `Blockchain data error: genesis hash mismatch (stored ${genesisHash}, local ${r.hash})`;
        }
      }
    } else if (r.prevHash !== rows[i - 1]!.hash) {
      return `Blockchain data error: block ${r.height} prevHash does not link to block ${r.height - 1}`;
    }
  }
  return null;
}

export interface ChainOpenResult {
  ok: boolean;
  /** Whether the file existed before opening (new vs. existing). */
  existed: boolean;
  /** Error text when ok=false (reason for the blockchain data error). */
  error?: string;
}

export interface ChainLocalTip {
  height: number;
  hash: string;
  /** Timestamp of the newest block (seconds). */
  ts: number;
}

/** Row for a local transaction output (UTXO). */
export interface LocalOutputRow {
  txid: string;
  index: number;
  address: string;
  amount: string;
  isChange: boolean;
  /** Height of the block containing the owning transaction; null for a pending broadcast. */
  height: number | null;
  /** txid of the transaction spending this output; null when unspent. */
  spentTxid: string | null;
  /** Whether the owning transaction is confirmed; false for a pending broadcast. */
  confirmed: boolean;
  /** Height at which a block mining reward matures (type=mining and inside a block); null for other outputs. */
  matureAtHeight: number | null;
  createdAt: string;
}

/** Local transaction detail (inputs/outputs), isomorphic to the shared TransactionDto (confirmations are recomputed by the querying side from height). */
export interface LocalTransactionDetail {
  txid: string;
  type: "transfer" | "mining";
  from: string | null;
  inputs: Array<{ txid: string; index: number; address: string; amount: string }>;
  outputs: Array<{ address: string; amount: string; isChange: boolean }>;
  fee: string;
  status: "confirmed" | "pending";
  blockHeight: number | null;
  confirmations: number;
  createdAt: string;
}

/** Payload of an outbox queue entry (offline-signed transaction awaiting broadcast): inputs/outputs/fee (isomorphic subset of shared SignedTransaction). */
export interface PendingTransactionPayload {
  inputs: Array<{ txid: string; index: number }>;
  outputs: Array<{ address: string; amount: string }>;
  fee: string;
}

/** Outbox queue entry (offline-signed transaction awaiting broadcast). */
export interface OutboxEntry {
  txid: string;
  payload: PendingTransactionPayload;
  status: "pending" | "broadcast" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_OUTPUT =
  "SELECT txid, idx AS \"index\", address, amount, is_change AS isChange, height, " +
  "spent_txid AS spentTxid, confirmed, mature_at_height AS matureAtHeight, created_at AS createdAt FROM tx_outputs";

/** Wallet-view output row (persistent own_utxos table, serving the wallet address's hot query paths). */
const SELECT_OWN_OUTPUT =
  "SELECT txid, idx AS \"index\", address, amount, is_change AS isChange, height, " +
  "spent_txid AS spentTxid, confirmed, mature_at_height AS matureAtHeight, created_at AS createdAt FROM own_utxos";

/** EDX amount string (≤8 decimals) → smallest unit (photon) BigInt. */
function photonAmount(value: string): string {
  return parseEdxAmount(value).toString();
}

/** Smallest unit (photon) BigInt → EDX string. */
function edxAmount(photons: string): string {
  return formatEdxAmount(BigInt(photons));
}

/** Whether the file header is a legacy encrypted database (EDXCHDB magic). */
export function isLegacyEncryptedChainDb(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const head = readFileSync(filePath).subarray(0, CHAIN_DB_MAGIC.length);
  return Buffer.from(CHAIN_DB_MAGIC, "ascii").equals(Buffer.from(head));
}

/** Creates the local chain database tables (schema v3). Idempotent (IF NOT EXISTS), shared by open and archival. */
function createChainSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- schema v3: block headers (hash/prev_hash/ts as columns); data holds slim block metadata (header/nonce/coinbase, no transactions)
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
    -- schema v3: full transactions inside a block (including confirmed mirrors of pending outbox txs); data (the old full DTO JSON) is removed, details are derived from tx_outputs.
    -- height = containing block height (rollback/indexing); block_height = the transaction's own blockHeight (null for premine, distinguishing "mined/premined")
    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      height INTEGER,
      block_height INTEGER,
      type TEXT NOT NULL,
      fee TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_height ON transactions(height);
    -- schema v3: transaction outputs (UTXO index); spent_txid marks which transaction spent the output (confirmed on-chain or locked for a local pending broadcast),
    -- spent_idx is the position of that output among the spending transaction's inputs (multi-input ordering, used for detail lookups)
    CREATE TABLE IF NOT EXISTS tx_outputs (
      txid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      address TEXT NOT NULL,
      amount TEXT NOT NULL,
      is_change INTEGER NOT NULL DEFAULT 0,
      height INTEGER,
      spent_txid TEXT,
      spent_idx INTEGER,
      confirmed INTEGER NOT NULL DEFAULT 0,
      mature_at_height INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (txid, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs(address);
    CREATE INDEX IF NOT EXISTS idx_tx_outputs_spent ON tx_outputs(spent_txid);
    -- schema v2: address ↔ transaction mapping (history queries)
    CREATE TABLE IF NOT EXISTS address_txs (
      address TEXT NOT NULL,
      txid TEXT NOT NULL,
      height INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (address, txid)
    );
    CREATE INDEX IF NOT EXISTS idx_address_txs_addr_height ON address_txs(address, height DESC);
    -- schema v2: offline-signed queue awaiting broadcast (pending=pending broadcast / broadcast=broadcast awaiting confirmation / failed=failed)
    CREATE TABLE IF NOT EXISTS outbox (
      txid TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- schema v3: wallet view (this wallet address's transactions and unspent outputs; stays in the active database and is never archived with segments).
    -- Hot paths (balance/UTXO/history) read only this view, decoupled from segments; data stays consistent with the full tables (it is a subset of the full index itself)
    CREATE TABLE IF NOT EXISTS own_txs (
      txid TEXT PRIMARY KEY,
      height INTEGER,
      block_height INTEGER,
      type TEXT NOT NULL,
      fee TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS own_utxos (
      txid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      address TEXT NOT NULL,
      amount TEXT NOT NULL,
      is_change INTEGER NOT NULL DEFAULT 0,
      height INTEGER,
      spent_txid TEXT,
      spent_idx INTEGER,
      confirmed INTEGER NOT NULL DEFAULT 0,
      mature_at_height INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (txid, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_own_utxos_spent ON own_utxos(spent_txid);
    -- schema v3: transaction input references (spending events). Once a segment file is sealed, outputs in old segments can no longer have spent flags written back,
    -- so tx_inputs records "which transaction spent which output" for cross-segment / any-address UTXO freshness merging
    CREATE TABLE IF NOT EXISTS tx_inputs (
      txid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      prev_txid TEXT NOT NULL,
      prev_idx INTEGER NOT NULL,
      PRIMARY KEY (txid, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_inputs_prev ON tx_inputs(prev_txid, prev_idx);
  `);
}

/** Archived segment info (registered in meta segments). */
export interface ChainSegment {
  /** Segment start height (inclusive). */
  start: number;
  /** Segment end height (inclusive). */
  end: number;
  /** Archive file name (relative to the archive dir; deflate-compressed sqlite copy). */
  file: string;
  /** Hash of the segment's tail block (segment boundary/anchor checks). */
  endHash: string;
}

/** Transactions pending indexation (on-chain in-block transactions normalized: coinbase mining + regular transfers). */
interface IndexedTx {
  txid: string;
  type: "transfer" | "mining";
  fee: string;
  createdAt: string;
  blockHeight: number | null;
  inputs: Array<{ txid: string; index: number; address: string }>;
  outputs: Array<{ address: string; amount: string; isChange: boolean }>;
}

/** Local chain database wrapper (on-disk sqlite, plaintext; writes persist automatically). */
export class ChainStore {
  private db: Database | null = null;

  /** Lazy cache of archived segments (decompressed in-memory database handles, at most two kept). */
  private readonly segmentCache = new Map<string, Database>();

  constructor(
    private readonly filePath: string,
    private readonly walletAddress = "",
    private readonly maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
  ) {}

  chainDbFilePath(): string {
    return this.filePath;
  }

  /** Whether the local database is open (guards async paths like block:push that can arrive before open). */
  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Opens the local database: creates it when missing; opens it when present (legacy encrypted databases need migration first) + integrity check. */
  open(): ChainOpenResult {
    try {
      this.close();
      if (isLegacyEncryptedChainDb(this.filePath)) {
        return { ok: false, existed: true, error: LEGACY_DB_NEEDS_MIGRATION };
      }
      if (!existsSync(this.filePath)) {
        this.db = new Database(this.filePath, { create: true });
        this.chmodDbFile();
        this.ensureSchema();
        return { ok: true, existed: false };
      }
      try {
        this.db = new Database(this.filePath);
      } catch {
        return {
          ok: false,
          existed: true,
          error: "Blockchain data error: database file is corrupted（区块数据错误：数据库文件损坏）",
        };
      }
      this.chmodDbFile();
      this.ensureSchema();
      const err = this.integrityCheck();
      if (err) {
        this.close();
        return { ok: false, existed: true, error: err };
      }
      return { ok: true, existed: true };
    } catch (e) {
      this.close();
      return { ok: false, existed: existsSync(this.filePath), error: `Blockchain data error: ${(e as Error).message}` };
    }
  }

  /** Tightens the on-disk database file permissions (POSIX 0600; best-effort on Windows). */
  private chmodDbFile(): void {
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // platform unsupported / file handle in use: ignore
    }
  }

  private requireDb(): Database {
    if (!this.db) throw new ChainDataError("Blockchain data error: chain database is not open");
    return this.db;
  }

  /** Whether the address is this wallet's own (own_* views apply only to the wallet address; other addresses go through the full index). */
  private isOwnAddress(address: string): boolean {
    return this.walletAddress !== "" && address === this.walletAddress;
  }

  private ensureSchema(): void {
    createChainSchema(this.requireDb());
    // Compatibility for v3 databases created without the block_height column (column migration)
    const db = this.requireDb();
    const cols = db.query("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "block_height")) {
      db.run("ALTER TABLE transactions ADD COLUMN block_height INTEGER");
    }
    this.setMeta("schema_version", CHAIN_DB_SCHEMA_VERSION);
  }

  /** Local chain height; returns -1 for an empty or unopened database (safe for error-reporting paths). */
  localHeight(): number {
    if (!this.db) return -1;
    const row = this.db.query("SELECT COALESCE(MAX(height), -1) AS h FROM blocks").get() as { h: number };
    return row.h;
  }

  localTip(): ChainLocalTip {
    const row = this.requireDb()
      .query("SELECT height, hash, ts FROM blocks ORDER BY height DESC LIMIT 1")
      .get() as { height: number; hash: string; ts: number } | null;
    return row ? { height: row.height, hash: row.hash, ts: row.ts } : { height: -1, hash: "", ts: 0 };
  }

  genesisHash(): string | null {
    return this.getMeta("genesis_hash");
  }

  /** Block hash at the given height; null when missing (for reorg/rollback comparison). */
  blockAt(height: number): { hash: string } | null {
    if (!this.db) return null;
    const row = this.db.query("SELECT hash FROM blocks WHERE height = ?").get(height) as { hash: string } | null;
    return row ?? null;
  }

  getMeta(key: string): string | null {
    const row = this.requireDb().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.requireDb().run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

/**
 * Appends blocks (ascending dedup, then whole-batch validation + transactional insert).
 * Chained validation: each block's prevHash must match its predecessor (in the local database or the
 * current batch); a missing predecessor (gap) or a hash mismatch throws ChainDataError.
 * In-block transactions (coinbase + SignedTransaction[]) are parsed into the transactions/tx_outputs/
 * tx_inputs/address_txs index: each transaction first marks its inputs as spent (including outputs
 * produced by earlier transactions in the same block), then inserts its own outputs.
 * The on-disk database persists automatically (WAL); no explicit save is needed.
 */
  appendBlocks(blocks: readonly Block[]): number {
    const db = this.requireDb();
    const tip = this.localTip();
    const sorted = [...blocks].sort((a, b) => a.header.height - b.header.height);
    const batch: Block[] = [];
    const seen = new Set<number>();
    for (const b of sorted) {
      if (b.header.height <= tip.height || seen.has(b.header.height)) continue;
      seen.add(b.header.height);
      batch.push(b);
    }
    if (batch.length === 0) return 0;
    const batchHash = new Map<number, string>();
    for (const b of batch) batchHash.set(b.header.height, b.hash);
    const prevHashAt = (height: number): string | null => {
      if (batchHash.has(height)) return batchHash.get(height)!;
      const row = db.query("SELECT hash FROM blocks WHERE height = ?").get(height) as { hash: string } | null;
      return row ? row.hash : null;
    };
    const insert = db.transaction(() => {
      for (const b of batch) {
        if (b.header.height === 0) {
          const zeros = "0".repeat(64);
          if (b.header.previousHash !== "" && b.header.previousHash !== zeros) {
            throw new ChainDataError("Blockchain data error: genesis block has a non-empty prevHash");
          }
        } else {
          const prev = prevHashAt(b.header.height - 1);
          if (!prev) {
            throw new ChainDataError(
              `Blockchain data error: block ${b.header.height} is missing its predecessor (height ${b.header.height - 1})`,
            );
          }
          if (prev !== b.header.previousHash) {
            throw new ChainDataError(
              `Blockchain data error: block ${b.header.height} prevHash mismatch (expected ${prev}, got ${b.header.previousHash})`,
            );
          }
        }
        // Store the block (data slimmed to block metadata: header/nonce/coinbase, no transactions)
        db.run("INSERT INTO blocks (height, hash, prev_hash, ts, data) VALUES (?, ?, ?, ?, ?)", [
          b.header.height,
          b.hash,
          b.header.previousHash,
          b.header.timestampSeconds,
          encodeBlock(b),
        ]);
        this.indexBlock(db, b);
      }
    });
    insert();
    const genesis = batch.find((b) => b.header.height === 0);
    if (genesis) this.setMeta("genesis_hash", genesis.hash);
    const top = batch[batch.length - 1]!;
    const topTs = top.header.timestampSeconds;
    if (topTs > 0) this.setMeta("last_block_time", String(topTs));
    // Archive by segment once the active database exceeds the threshold (rare heavy operation, only triggered by the byte threshold)
    this.maybeArchive();
    return batch.length;
  }

  /** Indexes all transactions in a single block (block already inserted; called inside the appendBlocks transaction). */
  private indexBlock(db: Database, block: Block): void {
    const createdAt = new Date(block.header.timestampSeconds * 1000).toISOString();
    // Mining transaction: coinbase outputs become mining outputs (maturity height = block height + COINBASE_MATURITY)
    if (block.coinbase && block.coinbase.outputs.length > 0) {
      const id = coinbaseId(block.header.height, block.coinbase);
      this.upsertTxIndex(
        db,
        {
          txid: id,
          type: "mining",
          fee: "0",
          createdAt,
          blockHeight: block.header.height,
          inputs: [],
          outputs: block.coinbase.outputs.map((output) => ({
            address: output.address,
            amount: output.amount,
            isChange: false,
          })),
        },
        block.header.height,
        true,
      );
    }
    for (const transaction of block.transactions) {
      const id = transactionId(transaction);
      const senderAddress = addressFromPublicKey(transaction.pubkey);
      // Input addresses are looked up from already-indexed outputs (inputs from other blocks/pages may not be indexed yet → empty, address mapping skipped)
      const inputs = transaction.inputs.map((input) => {
        const row = db
          .query("SELECT address FROM tx_outputs WHERE txid = ? AND idx = ?")
          .get(input.txid, input.index) as { address: string } | null;
        return { txid: input.txid, index: input.index, address: row?.address ?? "" };
      });
      this.upsertTxIndex(
        db,
        {
          txid: id,
          type: "transfer",
          fee: transaction.fee,
          createdAt,
          blockHeight: block.header.height,
          inputs,
          outputs: transaction.outputs.map((output) => ({
            address: output.address,
            amount: output.amount,
            isChange: output.address === senderAddress,
          })),
        },
        block.header.height,
        true,
      );
    }
  }

  /** Inserts/updates the index of one confirmed transaction (transactions/tx_outputs/tx_inputs/address_txs + own_* views). */
  private upsertTxIndex(db: Database, tx: IndexedTx, height: number, confirmed: boolean): void {
    const createdAt = tx.createdAt;
    // Insert the transaction row first (idempotent), then mark inputs spent, then insert outputs
    db.run(
      "INSERT INTO transactions (txid, height, block_height, type, fee, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(txid) DO UPDATE SET height=excluded.height, block_height=excluded.block_height, type=excluded.type, fee=excluded.fee, " +
        "status=excluded.status, created_at=excluded.created_at",
      [tx.txid, height, tx.blockHeight, tx.type, tx.fee, confirmed ? "confirmed" : "pending", createdAt],
    );
    // Inputs: mark as spent (only when the output already exists; cross-block/cross-page inputs may not be indexed yet, update only when present);
    // spent_idx records the input position for multi-input ordering in transaction detail lookups;
    // also write the tx_inputs spending reference (sealed segments can no longer write spent flags back, cross-segment freshness relies on this table)
    for (const [inIdx, input] of tx.inputs.entries()) {
      db.run("INSERT OR REPLACE INTO tx_inputs (txid, idx, prev_txid, prev_idx) VALUES (?, ?, ?, ?)", [
        tx.txid,
        inIdx,
        input.txid,
        input.index,
      ]);
      const spent = db
        .query("SELECT 1 AS hit FROM tx_outputs WHERE txid = ? AND idx = ?")
        .get(input.txid, input.index);
      if (spent) {
        db.run("UPDATE tx_outputs SET spent_txid = ?, spent_idx = ? WHERE txid = ? AND idx = ?", [
          tx.txid,
          inIdx,
          input.txid,
          input.index,
        ]);
      }
    }
    // Outputs: new UTXOs (confirmed flag, maturity height); output index = array position (TransactionOutput has no index field);
    // amounts are always stored as smallest-unit (photon) integer strings so SQL SUM aggregation never loses precision.
    // Maturity rule: only block mining rewards (type=mining inside a block) need maturity
    for (const [outIndex, output] of tx.outputs.entries()) {
      const matureAtHeight = tx.type === "mining" && tx.blockHeight !== null ? tx.blockHeight + COINBASE_MATURITY : null;
      db.run(
        "INSERT INTO tx_outputs (txid, idx, address, amount, is_change, height, spent_txid, spent_idx, confirmed, mature_at_height, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?) " +
          "ON CONFLICT(txid, idx) DO UPDATE SET address=excluded.address, amount=excluded.amount, " +
          "is_change=excluded.is_change, height=excluded.height, confirmed=excluded.confirmed, " +
          "mature_at_height=excluded.mature_at_height, created_at=excluded.created_at",
        [
          tx.txid,
          outIndex,
          output.address,
          photonAmount(output.amount),
          output.isChange ? 1 : 0,
          height,
          confirmed ? 1 : 0,
          matureAtHeight,
          createdAt,
        ],
      );
    }
    // Address ↔ transaction mapping (input addresses + output addresses)
    const addrInsert = db.prepare(
      "INSERT INTO address_txs (address, txid, height, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(address, txid) DO NOTHING",
    );
    try {
      const addrSeen = new Set<string>();
      for (const input of tx.inputs) {
        if (input.address && !addrSeen.has(input.address)) {
          addrSeen.add(input.address);
          addrInsert.run(input.address, tx.txid, height, createdAt);
        }
      }
      for (const output of tx.outputs) {
        if (output.address && !addrSeen.has(output.address)) {
          addrSeen.add(output.address);
          addrInsert.run(output.address, tx.txid, height, createdAt);
        }
      }
    } finally {
      // Un-finalized prepared statements hold file locks on Windows; release it as soon as we are done
      addrInsert.finalize();
    }
    // Wallet view (own_*): this wallet address's transactions and unspent outputs stay resident, so hot queries don't cross segments after archival
    if (this.walletAddress === "") return;
    const ownAffected =
      tx.inputs.some((i) => i.address === this.walletAddress) ||
      tx.outputs.some((o) => o.address === this.walletAddress);
    if (!ownAffected) return;
    db.run(
      "INSERT INTO own_txs (txid, height, block_height, type, fee, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(txid) DO UPDATE SET height=excluded.height, block_height=excluded.block_height, type=excluded.type, " +
        "fee=excluded.fee, status=excluded.status, created_at=excluded.created_at",
      [tx.txid, height, tx.blockHeight, tx.type, tx.fee, confirmed ? "confirmed" : "pending", createdAt],
    );
    // Spending this wallet's own output → mark spent
    for (const [inIdx, input] of tx.inputs.entries()) {
      if (input.address !== this.walletAddress) continue;
      db.run(
        "UPDATE own_utxos SET spent_txid = ?, spent_idx = ? WHERE txid = ? AND idx = ? AND spent_txid IS NULL",
        [tx.txid, inIdx, input.txid, input.index],
      );
    }
    // This wallet's own outputs → insert into own_utxos (maturity rule identical to the full index: only block mining rewards need maturity)
    const ownMatureAt = tx.type === "mining" && tx.blockHeight !== null ? tx.blockHeight + COINBASE_MATURITY : null;
    for (const [outIndex, output] of tx.outputs.entries()) {
      if (output.address !== this.walletAddress) continue;
      db.run(
        "INSERT INTO own_utxos (txid, idx, address, amount, is_change, height, spent_txid, spent_idx, confirmed, mature_at_height, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?) " +
          "ON CONFLICT(txid, idx) DO UPDATE SET address=excluded.address, amount=excluded.amount, " +
          "is_change=excluded.is_change, height=excluded.height, confirmed=excluded.confirmed, " +
          "mature_at_height=excluded.mature_at_height, created_at=excluded.created_at",
        [
          tx.txid,
          outIndex,
          output.address,
          photonAmount(output.amount),
          output.isChange ? 1 : 0,
          height,
          confirmed ? 1 : 0,
          ownMatureAt,
          createdAt,
        ],
      );
    }
  }

  truncate(height: number): number {
    const db = this.requireDb();
    const remove = db.transaction(() => {
      const victims = db
        .query("SELECT txid FROM transactions WHERE height > ?")
        .all(height) as Array<{ txid: string }>;
      // Restore outputs spent by rolled-back transactions (spent_txid pointing at a rolled-back tx → clear, including spent_idx); own_utxos synced the same way
      db.run(
        "UPDATE tx_outputs SET spent_txid = NULL, spent_idx = NULL WHERE spent_txid IN (SELECT txid FROM transactions WHERE height > ?)",
        [height],
      );
      db.run(
        "UPDATE own_utxos SET spent_txid = NULL, spent_idx = NULL WHERE spent_txid IN (SELECT txid FROM transactions WHERE height > ?)",
        [height],
      );
      for (const v of victims) {
        db.run("DELETE FROM tx_outputs WHERE txid = ?", [v.txid]);
        db.run("DELETE FROM address_txs WHERE txid = ?", [v.txid]);
        db.run("DELETE FROM own_utxos WHERE txid = ?", [v.txid]);
        db.run("DELETE FROM own_txs WHERE txid = ?", [v.txid]);
        db.run("DELETE FROM tx_inputs WHERE txid = ?", [v.txid]);
      }
      db.run("DELETE FROM transactions WHERE height > ?", [height]);
      const before = db.query("SELECT COUNT(*) AS c FROM blocks").get() as { c: number };
      db.run("DELETE FROM blocks WHERE height > ?", [height]);
      const after = db.query("SELECT COUNT(*) AS c FROM blocks").get() as { c: number };
      return before.c - after.c;
    });
    const removed = remove();
    // The new tip after the rollback becomes last_block_time
    const tip = this.localTip();
    if (tip.ts > 0) this.setMeta("last_block_time", String(tip.ts));
    return removed;
  }

  // ---- Segmented archival (active database over threshold → seal read-only compressed segments → clear old data; own_*/outbox are never archived) ----

  /** Archive directory (datadir/archive). */
  archiveDir(): string {
    return path.join(path.dirname(this.filePath), "archive");
  }

  /** Registered archive segments (ascending, meta segments JSON). */
  segmentIndex(): ChainSegment[] {
    const raw = this.getMeta("segments");
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as ChainSegment[];
      return Array.isArray(arr) ? arr.sort((a, b) => a.start - b.start) : [];
    } catch {
      return [];
    }
  }

  /** Canonical archive segment file name. */
  private segmentFileName(start: number, end: number): string {
    return `chain-${start}-${end}.db.z`;
  }

  /** Current archive segment count (for migration/status display). */
  get segmentCount(): number {
    return this.segmentIndex().length;
  }

  // ---- Cross-segment reads (archive segments decompressed lazily, read-only; hot paths use own_*/the active database and never reach this logic) ----

  /** Decompresses and (cached) opens the given archive segment as a read-only in-memory database; null on failure. */
  private openSegment(seg: ChainSegment): Database | null {
    const cached = this.segmentCache.get(seg.file);
    if (cached) return cached;
    try {
      const zPath = path.join(this.archiveDir(), seg.file);
      if (!existsSync(zPath)) return null;
      const bytes = inflateSync(readFileSync(zPath));
      const sdb = new Database(bytes as unknown as string);
      // Simple LRU: cache at most 2 segment handles
      while (this.segmentCache.size >= 2) {
        const oldest = this.segmentCache.keys().next().value as string | undefined;
        if (!oldest) break;
        try {
          this.segmentCache.get(oldest)?.close();
        } catch {
          // Ignore close failures
        }
        this.segmentCache.delete(oldest);
      }
      this.segmentCache.set(seg.file, sdb);
      return sdb;
    } catch {
      return null;
    }
  }

  /** Read-only handles of the active database plus every openable archive segment (for low-frequency merged queries). */
  private allParts(): Database[] {
    const parts: Database[] = [this.requireDb()];
    for (const seg of this.segmentIndex()) {
      const sdb = this.openSegment(seg);
      if (sdb) parts.push(sdb);
    }
    return parts;
  }

  /** Locates the segment containing the given height; returns null for the active-database window. */
  private findSegmentByHeight(height: number): ChainSegment | null {
    const segs = this.segmentIndex();
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!;
      if (height >= s.start && height <= s.end) return s;
    }
    return null;
  }

  /** Locates a segment by txid: prefers this wallet's own_txs.height, otherwise scans segment by segment (low frequency, any-address old transactions). */
  private findSegmentForTxid(txid: string): ChainSegment | null {
    const own = this.requireDb()
      .query("SELECT height FROM own_txs WHERE txid = ?")
      .get(txid) as { height: number | null } | null;
    if (own && own.height !== null) {
      const byHeight = this.findSegmentByHeight(own.height);
      if (byHeight) return byHeight;
    }
    for (const seg of [...this.segmentIndex()].reverse()) {
      const sdb = this.openSegment(seg);
      if (sdb && sdb.query("SELECT 1 AS hit FROM transactions WHERE txid = ?").get(txid)) return seg;
    }
    return null;
  }

  /** Resolves confirmed transaction details within the given database (active or archive segment; no redundant JSON storage). */
  private queryTxDetailIn(db: Database, txid: string): LocalTransactionDetail | null {
    const row = db
      .query(
        "SELECT txid, height, block_height AS blockHeight, type, fee, status, created_at AS createdAt FROM transactions WHERE txid = ?",
      )
      .get(txid) as {
      txid: string;
      height: number | null;
      blockHeight: number | null;
      type: string;
      fee: string;
      status: string;
      createdAt: string;
    } | null;
    if (!row) return null;
    const outputRows = db
      .query("SELECT address, amount, is_change AS isChange FROM tx_outputs WHERE txid = ? ORDER BY idx ASC")
      .all(txid) as Array<{ address: string; amount: string; isChange: number }>;
    const inputRows = db
      .query(
        'SELECT txid, idx AS "index", address, amount FROM tx_outputs WHERE spent_txid = ? ORDER BY spent_idx ASC, idx ASC',
      )
      .all(txid) as Array<{ txid: string; index: number; address: string; amount: string }>;
    return {
      txid,
      type: row.type === "mining" ? "mining" : "transfer",
      from: inputRows[0]?.address ?? null,
      inputs: inputRows.map((r) => ({ txid: r.txid, index: r.index, address: r.address, amount: edxAmount(r.amount) })),
      outputs: outputRows.map((r) => ({
        address: r.address,
        amount: edxAmount(r.amount),
        isChange: Boolean(r.isChange),
      })),
      fee: row.fee,
      status: row.status === "pending" ? "pending" : "confirmed",
      blockHeight: row.blockHeight,
      confirmations: 0,
      createdAt: row.createdAt,
    };
  }

  /** Set of spent-output references for an address in the given databases (tx_inputs × address_txs, cross-segment freshness merging). */
  private spentRefsFor(parts: Database[], address: string): Set<string> {
    const refs = new Set<string>();
    for (const part of parts) {
      const rows = part
        .query(
          "SELECT ti.prev_txid AS pt, ti.prev_idx AS pi FROM tx_inputs ti " +
            "JOIN address_txs at ON at.txid = ti.txid WHERE at.address = ?",
        )
        .all(address) as Array<{ pt: string; pi: number }>;
      for (const r of rows) refs.add(`${r.pt}:${r.pi}`);
    }
    return refs;
  }

  /** On-disk size of the active database (bytes; used for the segment threshold check). */
  private sqliteSizeBytes(db: Database): number {
    try {
      const pc = db.query("PRAGMA page_count").get() as { page_count: number };
      const ps = db.query("PRAGMA page_size").get() as { page_size: number };
      return Number(pc.page_count ?? 0) * Number(ps.page_size ?? 4096);
    } catch {
      return 0;
    }
  }

  /** Triggers archival by threshold after appendBlocks (active database above threshold with new segment data). */
  private maybeArchive(): void {
    const db = this.requireDb();
    const tip = this.localTip();
    if (tip.height < 4) return; // segments must contain a few blocks at least, avoid extremely short segments
    if (this.sqliteSizeBytes(db) < this.maxSegmentBytes) return;
    this.archiveSegment();
  }

/**
 * Seals a segment (idempotent, recoverable):
 * 1. VACUUM INTO produces a full compact copy of the active database (original tables intact) → drop the wallet-state
 *    tables (own_txs, own_utxos, outbox) → deflate-written to archive/chain-<start>-<end>.db.z;
 * 2. Segment registration is written to meta segments (register first, clear later: if interrupted midway, the next
 *    trigger detects "already registered up to the current tip" and only finishes the clear);
 * 3. Already-archived old data is cleared from the active database (the end-height anchor row is kept for the next
 *    segment's first-block predecessor check), then VACUUM reclaims space.
 * Returns the segment sealed this run; null when there is nothing new.
 */
  archiveSegment(): ChainSegment | null {
    const db = this.requireDb();
    const tip = this.localTip();
    if (tip.height < 0) return null;
    const segs = this.segmentIndex();
    const start = segs.length === 0 ? 0 : segs[segs.length - 1]!.end + 1;
    const end = tip.height;
    if (end < start + 1) return null;
    const segFile = this.segmentFileName(start, end);
    const prevEndHash = segs.length === 0 ? "" : segs[segs.length - 1]!.endHash;
    // If the previous seal already registered up to the current tip (clear was interrupted): skip the export, just finish the clear
    const alreadyRegistered = segs.length > 0 && segs[segs.length - 1]!.end === end;
    if (!alreadyRegistered) {
      mkdirSync(this.archiveDir(), { recursive: true });
      const tmpDb = path.join(this.archiveDir(), `chain-${start}-${end}.db.tmp`);
      const tmpZ = path.join(this.archiveDir(), segFile);
      rmSync(tmpDb, { force: true });
      rmSync(tmpZ, { force: true });
      db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
      // Segment boundary check: this segment's first-block prevHash must equal the previous segment's tail hash
      if (prevEndHash) {
        const firstRow = db.query("SELECT prev_hash AS prevHash FROM blocks WHERE height = ?").get(start) as
          | { prevHash: string }
          | null;
        if (firstRow && firstRow.prevHash !== prevEndHash) {
          rmSync(tmpDb, { force: true });
          throw new ChainDataError("Blockchain data error: segment boundary mismatch");
        }
      }
      // The copy drops the wallet-state tables (own_*/outbox exist only in the active database, never in segments)
      const copy = new Database(tmpDb);
      copy.exec("DROP TABLE IF EXISTS own_txs; DROP TABLE IF EXISTS own_utxos; DROP TABLE IF EXISTS outbox;");
      copy.close();
      const raw = readFileSync(tmpDb);
      writeFileSync(tmpZ, deflateSync(raw, { level: 6 }));
      rmSync(tmpDb, { force: true });
      this.setMeta("segments", JSON.stringify([...segs, { start, end, file: segFile, endHash: tip.hash }]));
      if (segs.length === 0) this.setMeta("first_segment_start", String(start));
    }
    // Clear already-archived data from the active database: delete chain data with height < end, keep the end anchor row
    const clear = db.transaction(() => {
      db.run("DELETE FROM tx_outputs WHERE height < ?", [end]);
      db.run("DELETE FROM transactions WHERE height < ?", [end]);
      db.run("DELETE FROM address_txs WHERE height < ?", [end]);
      db.run("DELETE FROM blocks WHERE height < ?", [end]);
    });
    clear();
    db.exec("VACUUM");
    this.chmodDbFile();
    return { start, end, file: segFile, endHash: tip.hash };
  }

  /** Deletes the local database file and rebuilds an empty one (for resync; also deletes every archive segment). */
  rebuild(): void {
    this.close();
    if (existsSync(this.filePath)) rmSync(this.filePath, { force: true });
    rmSync(this.archiveDir(), { recursive: true, force: true });
    this.db = new Database(this.filePath, { create: true });
    this.chmodDbFile();
    this.ensureSchema();
  }

  // ---- Local address queries (balance / UTXO / history / detail) ----

/** Address balance (photon bigint): sum of confirmed unspent outputs (including immature mining rewards).
 *  The wallet address reads the persistent own_utxos view (no cross-segment reads after archival); other addresses use the full tx_outputs. */
  addressBalance(address: string): bigint {
    const db = this.requireDb();
    if (this.isOwnAddress(address)) {
      const rows = db
        .query("SELECT amount FROM own_utxos WHERE confirmed = 1 AND spent_txid IS NULL")
        .all() as Array<{ amount: string }>;
      return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    }
    // Non-wallet address: merged across segments (candidate outputs − spent references; tx_inputs × address_txs merging keeps cross-segment freshness)
    const parts = this.allParts();
    const spentRefs = this.spentRefsFor(parts, address);
    let total = 0n;
    for (const part of parts) {
      const rows = part
        .query("SELECT txid, idx, amount FROM tx_outputs WHERE address = ? AND confirmed = 1 AND spent_txid IS NULL")
        .all(address) as Array<{ txid: string; idx: number; amount: string }>;
      for (const r of rows) {
        if (!spentRefs.has(`${r.txid}:${r.idx}`)) total += BigInt(r.amount);
      }
    }
    return total;
  }

  /** Address immature amount (photon bigint): confirmed, unspent, and mining rewards that have not yet reached the maturity confirmation count. */
  addressImmature(address: string, currentHeight: number): bigint {
    const db = this.requireDb();
    if (this.isOwnAddress(address)) {
      const rows = db
        .query(
          "SELECT amount FROM own_utxos WHERE confirmed = 1 AND spent_txid IS NULL " +
            "AND mature_at_height IS NOT NULL AND mature_at_height > ?",
        )
        .all(currentHeight) as Array<{ amount: string }>;
      return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    }
    // Non-wallet address: merged across segments (candidate outputs − spent references; tx_inputs + address_txs merging keeps cross-segment freshness)
    const parts = this.allParts();
    const spentRefs = this.spentRefsFor(parts, address);
    let total = 0n;
    for (const part of parts) {
      const rows = part
        .query(
          "SELECT txid, idx, amount FROM tx_outputs WHERE address = ? AND confirmed = 1 AND spent_txid IS NULL " +
            "AND mature_at_height IS NOT NULL AND mature_at_height > ?",
        )
        .all(address, currentHeight) as Array<{ txid: string; idx: number; amount: string }>;
      for (const r of rows) {
        if (!spentRefs.has(`${r.txid}:${r.idx}`)) total += BigInt(r.amount);
      }
    }
    return total;
  }

/** Spendable UTXOs (confirmed, unspent and mature). amount is an EDX string.
 *  Maturity is judged against the current chain height (backend height, not the locally downloaded height): when the
 *  local chain lags, rewards still mature from the backend's perspective. */
  addressUtxos(address: string, currentHeight: number): LocalOutputRow[] {
    const db = this.requireDb();
    if (this.isOwnAddress(address)) {
      const rows = db
        .query(
          `${SELECT_OWN_OUTPUT} WHERE confirmed = 1 AND spent_txid IS NULL ` +
            "AND (mature_at_height IS NULL OR mature_at_height <= ?) ORDER BY created_at ASC, idx ASC",
        )
        .all(currentHeight) as LocalOutputRow[];
      return rows.map((r) => ({ ...r, amount: edxAmount(r.amount) }));
    }
    // Non-wallet address: merged across segments
    const parts = this.allParts();
    const spentRefs = this.spentRefsFor(parts, address);
    const cands: LocalOutputRow[] = [];
    for (const part of parts) {
      const rows = part
        .query(
          `${SELECT_OUTPUT} WHERE address = ? AND confirmed = 1 AND spent_txid IS NULL ` +
            "AND (mature_at_height IS NULL OR mature_at_height <= ?)",
        )
        .all(address, currentHeight) as LocalOutputRow[];
      for (const r of rows) {
        if (!spentRefs.has(`${r.txid}:${r.index}`)) cands.push(r);
      }
    }
    cands.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.index - b.index));
    return cands.map((r) => ({ ...r, amount: edxAmount(r.amount) }));
  }

/** Address transaction history (confirmed + outbox pending), newest first.
 *  The wallet address reads the persistent own_txs view; other addresses are merged across segments (low frequency). */
  addressTxids(address: string, limit: number): Array<{ txid: string; createdAt: string }> {
    const db = this.requireDb();
    if (this.isOwnAddress(address)) {
      const rows = db
        .query("SELECT txid, created_at AS createdAt FROM own_txs ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, limit)) as Array<{ txid: string; createdAt: string }>;
      return rows;
    }
    const parts = this.allParts();
    const all: Array<{ txid: string; createdAt: string }> = [];
    for (const part of parts) {
      const rows = part
        .query("SELECT txid, created_at AS createdAt FROM address_txs WHERE address = ? ORDER BY created_at DESC LIMIT ?")
        .all(address, Math.max(1, limit)) as Array<{ txid: string; createdAt: string }>;
      all.push(...rows);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.slice(0, Math.max(1, limit));
  }

  /** Single transaction detail (confirmed or outbox pending): prefers the active database, locates the archive segment by height for old transactions; null when missing. */
  getLocalTx(txid: string): LocalTransactionDetail | null {
    const db = this.requireDb();
    const local = this.queryTxDetailIn(db, txid);
    if (local) return local;
    // Archived old transactions: locate the segment via own_txs.height, otherwise scan segment by segment (low frequency)
    const seg = this.findSegmentForTxid(txid);
    if (seg) {
      const sdb = this.openSegment(seg);
      if (sdb) {
        const fromSeg = this.queryTxDetailIn(sdb, txid);
        if (fromSeg) return fromSeg;
      }
    }
    const ob = db.query("SELECT payload FROM outbox WHERE txid = ?").get(txid) as { payload: string } | null;
    if (ob) {
      const payload = JSON.parse(ob.payload) as PendingTransactionPayload;
      // Fill in input addresses/amounts from the local UTXO index (a pending transaction's inputs reference locally confirmed outputs)
      const inputs = payload.inputs.map((input) => {
        const utxo = db
          .query("SELECT address, amount FROM tx_outputs WHERE txid = ? AND idx = ?")
          .get(input.txid, input.index) as { address: string; amount: string } | null;
        return {
          txid: input.txid,
          index: input.index,
          address: utxo?.address ?? "",
          amount: utxo ? edxAmount(utxo.amount) : "0",
        };
      });
      const changeIndex = payload.outputs.findIndex((o) => o.address === this.walletAddress);
      return {
        txid,
        type: "transfer",
        from: inputs[0]?.address ?? null,
        inputs,
        // 0-amount change (placeholder output added when a split batch transfers everything out) is not shown
        outputs: payload.outputs
          .map((output, index) => ({
            address: output.address,
            amount: output.amount,
            isChange: index === changeIndex,
          }))
          .filter((o) => !(o.isChange && parseEdxAmount(o.amount) === 0n)),
        fee: payload.fee,
        status: "pending",
        blockHeight: null,
        confirmations: 0,
        createdAt: new Date().toISOString(),
      };
    }
    return null;
  }

  /** Whether the transaction is in confirmed status (present in the local chain database). */
  isConfirmedTx(txid: string): boolean {
    const db = this.requireDb();
    const row = db.query("SELECT status FROM transactions WHERE txid = ?").get(txid) as { status: string } | null;
    return row?.status === "confirmed";
  }

  // ---- Outbox pending-broadcast queue ----

  listOutbox(): OutboxEntry[] {
    const db = this.requireDb();
    const rows = db
      .query(
        "SELECT txid, payload, status, attempts, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM outbox ORDER BY created_at ASC",
      )
      .all() as Array<{
      txid: string;
      payload: string;
      status: string;
      attempts: number;
      lastError: string | null;
      createdAt: number;
      updatedAt: number;
    }>;
    return rows.map((r) => ({
      txid: r.txid,
      payload: JSON.parse(r.payload) as PendingTransactionPayload,
      status: r.status as OutboxEntry["status"],
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Writes/updates an outbox entry (payload overwritten idempotently; status/attempts preserved). */
  upsertOutbox(entry: OutboxEntry): void {
    const db = this.requireDb();
    db.run(
      "INSERT INTO outbox (txid, payload, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(txid) DO UPDATE SET payload=excluded.payload, status=excluded.status, attempts=excluded.attempts, " +
        "last_error=excluded.last_error, updated_at=excluded.updated_at",
      [
        entry.txid,
        JSON.stringify(entry.payload),
        entry.status,
        entry.attempts,
        entry.lastError,
        entry.createdAt,
        entry.updatedAt,
      ],
    );
  }

  /** Updates outbox status fields (status/attempts/lastError/updatedAt). */
  updateOutboxStatus(txid: string, patch: Partial<Pick<OutboxEntry, "status" | "attempts" | "lastError">>): void {
    const db = this.requireDb();
    const row = db.query("SELECT status, attempts FROM outbox WHERE txid = ?").get(txid) as
      | { status: string; attempts: number }
      | null;
    if (!row) return;
    const status = patch.status ?? row.status;
    const attempts = patch.attempts ?? row.attempts;
    const lastError = patch.lastError !== undefined ? patch.lastError : null;
    db.run("UPDATE outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE txid = ?", [
      status,
      attempts,
      lastError,
      Date.now(),
      txid,
    ]);
  }

  /** Removes an outbox entry. */
  deleteOutbox(txid: string): void {
    this.requireDb().run("DELETE FROM outbox WHERE txid = ?", [txid]);
  }

/**
 * Locally locks a pending transaction's input UTXOs (marks spent_txid = txid) to prevent the same wallet from
 * double-spending. Inputs/outputs are not locally indexed yet (an offline pending transaction locks confirmed
 * outputs) → no pending outputs are written; unlocking after a failed broadcast is handled by unlockOutboxInputs.
 */
  lockOutboxInputs(txid: string, inputs: Array<{ txid: string; index: number }>): void {
    const db = this.requireDb();
    const lock = db.transaction(() => {
      for (const [inIdx, input] of inputs.entries()) {
        db.run(
          "UPDATE tx_outputs SET spent_txid = ?, spent_idx = ? WHERE txid = ? AND idx = ? AND spent_txid IS NULL",
          [txid, inIdx, input.txid, input.index],
        );
        // Sync the lock into the wallet view (update only when a row exists for this address's outputs)
        db.run(
          "UPDATE own_utxos SET spent_txid = ?, spent_idx = ? WHERE txid = ? AND idx = ? AND spent_txid IS NULL",
          [txid, inIdx, input.txid, input.index],
        );
      }
    });
    lock();
  }

  /** Releases the input lock of the given transaction (clears only where spent_txid points at that transaction). */
  unlockOutboxInputs(txid: string): void {
    this.requireDb().run("UPDATE tx_outputs SET spent_txid = NULL, spent_idx = NULL WHERE spent_txid = ?", [txid]);
    this.requireDb().run("UPDATE own_utxos SET spent_txid = NULL, spent_idx = NULL WHERE spent_txid = ?", [txid]);
  }

  // ---- Persistence ----

/**
 * Integrity check (run on open): chained linkage (column-based; the slimmed data field no longer participates).
 * Returns an error message; null on success.
 */
  integrityCheck(): string | null {
    const db = this.requireDb();
    const rows = db
      .query("SELECT height, hash, prev_hash FROM blocks ORDER BY height ASC")
      .all() as Array<{ height: number; hash: string; prev_hash: string }>;
    if (rows.length === 0) return null;
    return chainLinkageError(
      rows.map((r) => ({ height: r.height, hash: r.hash, prevHash: r.prev_hash })),
      this.getMeta("genesis_hash"),
    );
  }

  close(): void {
    this.db?.close();
    this.db = null;
    for (const seg of this.segmentCache.values()) {
      try {
        seg.close();
      } catch {
        // Ignore segment close failures
      }
    }
    this.segmentCache.clear();
  }

  /** Whether the data file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** On-disk file path (for tests/archival checks). */
  get fileSize(): number {
    try {
      const info = readFileSync(this.filePath);
      return info.length;
    } catch {
      return 0;
    }
  }
}

/** Block metadata encoding (data column): header (serialized difficulty) + hash + nonce + coinbase; no transactions (v3 slimmed). */
function encodeBlock(block: Block): string {
  return JSON.stringify({
    header: { ...block.header, difficulty: block.header.difficulty.toString() },
    hash: block.hash,
    nonce: block.nonce,
    coinbase: block.coinbase,
  });
}