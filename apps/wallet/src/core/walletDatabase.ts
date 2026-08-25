import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  COINBASE_MATURITY,
  addressFromPublicKey,
  formatEdxAmount,
  parseEdxAmount,
  transactionId,
} from "@edgex/shared";
import type { SignedTransaction } from "@edgex/shared";
import { coinbaseId } from "@edgex/core";
import type { Block } from "@edgex/core";

export const CHAIN_DB_MAGIC = "EDXCHDB";
export const CHAIN_DB_VERSION = 1;
export const CHAIN_DB_IV_LENGTH = 12;
export const CHAIN_DB_TAG_LENGTH = 16;
export const CHAIN_DB_SCHEMA_VERSION = "2";

export class ChainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainDataError";
  }
}

export function deriveChainDbKey(walletPrivateKey: Uint8Array): Buffer {
  return createHash("sha256")
    .update(Buffer.from("EDX-CHAINDB:v1", "utf8"))
    .update(Buffer.from(walletPrivateKey))
    .digest();
}

export function encryptChainDb(bytes: Uint8Array, key: Buffer): Uint8Array {
  const iv = randomBytes(CHAIN_DB_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  const header = Buffer.concat([Buffer.from(CHAIN_DB_MAGIC, "ascii"), Buffer.from([CHAIN_DB_VERSION])]);
  return new Uint8Array(Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]));
}

export function decryptChainDb(data: Uint8Array, key: Buffer): Uint8Array {
  const buf = Buffer.from(data);
  const magic = Buffer.from(CHAIN_DB_MAGIC, "ascii");
  const minLength = magic.length + 1 + CHAIN_DB_IV_LENGTH + CHAIN_DB_TAG_LENGTH;
  if (buf.length < minLength || !buf.subarray(0, magic.length).equals(magic)) {
    throw new ChainDataError("Blockchain data error: file is not an EdgeX chain database or is corrupted");
  }
  const version = buf[magic.length]!;
  if (version !== CHAIN_DB_VERSION) {
    throw new ChainDataError(`Blockchain data error: unsupported chain database version ${version}`);
  }
  let offset = magic.length + 1;
  const iv = buf.subarray(offset, offset + CHAIN_DB_IV_LENGTH);
  offset += CHAIN_DB_IV_LENGTH;
  const tag = buf.subarray(buf.length - CHAIN_DB_TAG_LENGTH);
  const ciphertext = buf.subarray(offset, buf.length - CHAIN_DB_TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new ChainDataError("Blockchain data error: decryption failed; data belongs to another wallet or is corrupt");
  }
}

function encodeBlock(block: Block): string {
  return JSON.stringify({
    header: { ...block.header, difficulty: block.header.difficulty.toString() },
    hash: block.hash,
    nonce: block.nonce,
    coinbase: block.coinbase,
  });
}

function decodeBlock(json: string): Block {
  const raw = JSON.parse(json) as Block & { header: { difficulty: string } };
  return { ...raw, header: { ...raw.header, difficulty: BigInt(raw.header.difficulty) }, transactions: [] };
}

function photonAmount(value: string): string {
  return parseEdxAmount(value).toString();
}

function edxAmount(photons: string): string {
  return formatEdxAmount(BigInt(photons));
}

function txIdentifier(transaction: SignedTransaction): string {
  return transactionId(transaction);
}

export interface ChainLocalTip {
  height: number;
  hash: string;
  ts: number;
}

export interface LocalOutputRow {
  txid: string;
  index: number;
  address: string;
  amount: string;
  isChange: boolean;
  height: number | null;
  spentTxid: string | null;
  confirmed: boolean;
  matureAtHeight: number | null;
  createdAt: string;
}

export interface LocalTransactionDetail {
  txid: string;
  type: "transfer" | "mining";
  from: string | null;
  inputs: Array<{ txid: string; index: number; address: string; amount: string }>;
  outputs: Array<{ address: string; amount: string; isChange: boolean }>;
  fee: string;
  status: "pending" | "confirmed";
  blockHeight: number | null;
  confirmations: number;
  createdAt: string;
}

const SELECT_OUTPUT =
  'SELECT txid, idx AS "index", address, amount, is_change AS isChange, height, ' +
  "spent_txid AS spentTxid, confirmed, mature_at_height AS matureAtHeight, created_at AS createdAt FROM tx_outputs";

/** Whole-file encrypted SQLite cache bound cryptographically to one wallet private key. */
export class ChainStore {
  private database: Database | null = null;

  constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
    private readonly walletAddress = "",
  ) {}

  chainDbFilePath(): string {
    return this.filePath;
  }

  open(): { ok: boolean; existed: boolean; error?: string } {
    try {
      this.close();
      if (!existsSync(this.filePath)) {
        this.database = new Database(":memory:");
        this.ensureSchema();
        return { ok: true, existed: false };
      }
      let bytes: Uint8Array;
      try {
        bytes = decryptChainDb(new Uint8Array(readFileSync(this.filePath)), this.key);
      } catch (error) {
        return { ok: false, existed: true, error: (error as Error).message };
      }
      try {
        this.database = new Database(bytes as unknown as string);
      } catch {
        return { ok: false, existed: true, error: "Blockchain data error: database file is corrupted" };
      }
      this.ensureSchema();
      const linkage = this.integrityCheck();
      if (linkage) {
        this.close();
        return { ok: false, existed: true, error: linkage };
      }
      return { ok: true, existed: true };
    } catch (error) {
      this.close();
      return { ok: false, existed: existsSync(this.filePath), error: (error as Error).message };
    }
  }

  private requireDatabase(): Database {
    if (!this.database) throw new ChainDataError("Blockchain data error: chain database is not open");
    return this.database;
  }

  private ensureSchema(): void {
    const db = this.requireDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY, hash TEXT NOT NULL, prev_hash TEXT NOT NULL,
        ts INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
      CREATE TABLE IF NOT EXISTS transactions (
        txid TEXT PRIMARY KEY, height INTEGER, type TEXT NOT NULL, fee TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_height ON transactions(height);
      CREATE TABLE IF NOT EXISTS tx_outputs (
        txid TEXT NOT NULL, idx INTEGER NOT NULL, address TEXT NOT NULL, amount TEXT NOT NULL,
        is_change INTEGER NOT NULL DEFAULT 0, height INTEGER, spent_txid TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0, mature_at_height INTEGER, created_at TEXT NOT NULL,
        PRIMARY KEY (txid, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs(address);
      CREATE INDEX IF NOT EXISTS idx_tx_outputs_spent ON tx_outputs(spent_txid);
      CREATE TABLE IF NOT EXISTS address_txs (
        address TEXT NOT NULL, txid TEXT NOT NULL, height INTEGER, created_at TEXT NOT NULL,
        PRIMARY KEY (address, txid)
      );
      CREATE INDEX IF NOT EXISTS idx_address_txs_addr_height ON address_txs(address, height DESC);
      CREATE TABLE IF NOT EXISTS outbox (
        txid TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    this.setMeta("schema_version", CHAIN_DB_SCHEMA_VERSION);
  }

  localHeight(): number {
    if (!this.database) return -1;
    const row = this.database.query("SELECT COALESCE(MAX(height), -1) AS h FROM blocks").get() as { h: number };
    return row.h;
  }

  localTip(): ChainLocalTip {
    const row = this.requireDatabase()
      .query("SELECT height, hash, ts FROM blocks ORDER BY height DESC LIMIT 1")
      .get() as { height: number; hash: string; ts: number } | null;
    return row ?? { height: -1, hash: "", ts: 0 };
  }

  genesisHash(): string | null {
    return this.getMeta("genesis_hash");
  }

  getMeta(key: string): string | null {
    const row = this.requireDatabase().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.requireDatabase().run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, value],
    );
  }

  appendBlocks(blocks: readonly Block[]): number {
    const db = this.requireDatabase();
    const tipHeight = this.localTip().height;
    const batch = [...blocks]
      .filter((block, index, list) => block.header.height > tipHeight && list.findIndex((item) => item.header.height === block.header.height) === index)
      .sort((left, right) => left.header.height - right.header.height);
    if (batch.length === 0) return 0;

    const insert = db.transaction(() => {
      let previousHash = tipHeight >= 0 ? this.localTip().hash : "";
      for (const block of batch) {
        const acceptsGenesis = block.header.height === 0 && previousHash === "";
        if (!acceptsGenesis && block.header.previousHash !== previousHash) {
          throw new ChainDataError(`Blockchain data error: block ${block.header.height} prevHash mismatch`);
        }
        db.run("INSERT INTO blocks(height,hash,prev_hash,ts,data) VALUES(?,?,?,?,?)", [
          block.header.height,
          block.hash,
          block.header.previousHash,
          block.header.timestampSeconds,
          encodeBlock(block),
        ]);
        this.indexBlock(db, block);
        previousHash = block.hash;
      }
    });
    insert();
    const first = batch[0]!;
    if (first.header.height === 0) this.setMeta("genesis_hash", first.hash);
    this.setMeta("last_block_time", String(batch[batch.length - 1]!.header.timestampSeconds));
    return batch.length;
  }

  private indexBlock(db: Database, block: Block): void {
    const createdAt = new Date(block.header.timestampSeconds * 1000).toISOString();
    if (block.coinbase) {
      const id = coinbaseId(block.header.height, block.coinbase);
      const output = block.coinbase.outputs[0];
      if (output) {
        this.upsertTransaction(db, {
          txid: id,
          type: "mining",
          fee: "0",
          status: "confirmed",
          createdAt,
          detail: {
            txid: id,
            type: "mining",
            from: null,
            inputs: [],
            outputs: [{ ...output, isChange: false }],
            fee: "0",
            status: "confirmed",
            blockHeight: block.header.height,
            confirmations: 1,
            createdAt,
          },
        });
        this.upsertOutput(db, id, 0, output.address, output.amount, false, block.header.height, true, block.header.height + COINBASE_MATURITY, createdAt);
        this.linkAddress(db, output.address, id, block.header.height, createdAt);
      }
    }

      for (const transaction of block.transactions) {
        const id = txIdentifier(transaction);
        const senderAddress = addressFromPublicKey(transaction.pubkey);
        const inputs = transaction.inputs.map((input) => {
          const row = db.query("SELECT address,amount FROM tx_outputs WHERE txid=? AND idx=?")
            .get(input.txid, input.index) as { address: string; amount: string } | null;
          return { txid: input.txid, index: input.index, address: row?.address ?? "", amount: row ? edxAmount(row.amount) : "0" };
        });
      this.upsertTransaction(db, {
        txid: id,
        type: "transfer",
        fee: transaction.fee,
        status: "confirmed",
        createdAt,
        detail: {
          txid: id,
          type: "transfer",
          from: senderAddress,
          inputs,
          outputs: transaction.outputs.map((output) => ({ ...output, isChange: output.address === senderAddress })),
          fee: transaction.fee,
          status: "confirmed",
          blockHeight: block.header.height,
          confirmations: 1,
          createdAt,
        },
      });
      for (const input of transaction.inputs) {
        db.run("UPDATE tx_outputs SET spent_txid=? WHERE txid=? AND idx=?", [id, input.txid, input.index]);
      }
      transaction.outputs.forEach((output, index) => {
        this.upsertOutput(db, id, index, output.address, output.amount, output.address === senderAddress, block.header.height, true, null, createdAt);
        this.linkAddress(db, output.address, id, block.header.height, createdAt);
      });
      this.linkAddress(db, senderAddress, id, block.header.height, createdAt);
    }
  }

  private upsertTransaction(
    db: Database,
    value: { txid: string; type: string; fee: string; status: string; createdAt: string; detail: unknown },
  ): void {
    const detail = value.detail as LocalTransactionDetail;
    db.run(
      "INSERT INTO transactions(txid,height,type,fee,status,created_at,data) VALUES(?,?,?,?,?,?,?) " +
        "ON CONFLICT(txid) DO UPDATE SET height=excluded.height,type=excluded.type,fee=excluded.fee," +
        "status=excluded.status,created_at=excluded.created_at,data=excluded.data",
      [value.txid, detail.blockHeight, value.type, value.fee, value.status, value.createdAt, JSON.stringify(detail)],
    );
  }

  private upsertOutput(
    db: Database,
    txid: string,
    index: number,
    address: string,
    amount: string,
    isChange: boolean,
    height: number | null,
    confirmed: boolean,
    matureAtHeight: number | null,
    createdAt: string,
  ): void {
    db.run(
      "INSERT INTO tx_outputs(txid,idx,address,amount,is_change,height,spent_txid,confirmed,mature_at_height,created_at)" +
        " VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(txid,idx) DO UPDATE SET address=excluded.address," +
        "amount=excluded.amount,is_change=excluded.is_change,height=excluded.height,confirmed=excluded.confirmed," +
        "mature_at_height=excluded.mature_at_height,created_at=excluded.created_at",
      [txid, index, address, photonAmount(amount), isChange ? 1 : 0, height, null, confirmed ? 1 : 0, matureAtHeight, createdAt],
    );
  }

  private linkAddress(db: Database, address: string, txid: string, height: number | null, createdAt: string): void {
    db.run("INSERT OR IGNORE INTO address_txs(address,txid,height,created_at) VALUES(?,?,?,?)", [address, txid, height, createdAt]);
  }

  truncate(height: number): number {
    const db = this.requireDatabase();
    const remove = db.transaction(() => {
      db.run("UPDATE tx_outputs SET spent_txid=NULL WHERE spent_txid IN (SELECT txid FROM transactions WHERE height>?)", [height]);
      db.run("DELETE FROM tx_outputs WHERE height>?", [height]);
      db.run("DELETE FROM address_txs WHERE height>?", [height]);
      db.run("DELETE FROM transactions WHERE height>?", [height]);
      const before = db.query("SELECT COUNT(*) AS c FROM blocks").get() as { c: number };
      db.run("DELETE FROM blocks WHERE height>?", [height]);
      return before.c - (db.query("SELECT COUNT(*) AS c FROM blocks").get() as { c: number }).c;
    });
    const removed = remove();
    const tip = this.localTip();
    if (tip.ts > 0) this.setMeta("last_block_time", String(tip.ts));
    return removed;
  }

  rebuild(): void {
    this.close();
    if (existsSync(this.filePath)) rmSync(this.filePath, { force: true });
    this.database = new Database(":memory:");
    this.ensureSchema();
  }

  addressBalance(address: string): bigint {
    const rows = this.requireDatabase()
      .query("SELECT amount FROM tx_outputs WHERE address=? AND confirmed=1 AND spent_txid IS NULL")
      .all(address) as Array<{ amount: string }>;
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }

  addressImmature(address: string, currentHeight: number): bigint {
    const rows = this.requireDatabase()
      .query("SELECT amount FROM tx_outputs WHERE address=? AND confirmed=1 AND spent_txid IS NULL AND mature_at_height IS NOT NULL AND mature_at_height>?")
      .all(address, currentHeight) as Array<{ amount: string }>;
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }

  addressUtxos(address: string, currentHeight: number): LocalOutputRow[] {
    const rows = this.requireDatabase()
      .query(`${SELECT_OUTPUT} WHERE address=? AND confirmed=1 AND spent_txid IS NULL AND (mature_at_height IS NULL OR mature_at_height<=?) ORDER BY created_at ASC,idx ASC`)
      .all(address, currentHeight) as Array<Omit<LocalOutputRow, "amount"> & { amount: string }>;
    return rows.map((row) => ({ ...row, amount: edxAmount(row.amount) }));
  }

  integrityCheck(): string | null {
    const rows = this.requireDatabase()
      .query("SELECT height,hash,prev_hash,data FROM blocks ORDER BY height ASC")
      .all() as Array<{ height: number; hash: string; prev_hash: string; data: string }>;
    for (const [index, row] of rows.entries()) {
      const expectedPrevious = index === 0 ? "0".repeat(64) : rows[index - 1]!.hash;
      if (row.height !== index || row.prev_hash !== expectedPrevious) {
        return `Blockchain data error: local chain has a gap or broken link at height ${row.height}`;
      }
      try {
        decodeBlock(row.data);
      } catch {
        return `Blockchain data error: block ${row.height} payload is corrupted`;
      }
    }
    return null;
  }

  save(): void {
    const encrypted = encryptChainDb(this.requireDatabase().serialize(), this.key);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, encrypted, { mode: 0o600 });
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
