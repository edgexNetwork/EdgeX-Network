import { Database } from 'bun:sqlite';
import type { Block } from '@edgex/core';
import { GENESIS_HASH } from '@edgex/core';

interface StoredBlockRow {
  hash: string;
  height: number;
  payload_json: string;
  total_work: string;
}

/** JSON codecs make the difficulty/amount BigInt boundary explicit. */
export function encodeBlock(block: Block): string {
  return JSON.stringify({
    header: { ...block.header, difficulty: block.header.difficulty.toString() },
    hash: block.hash,
    nonce: block.nonce,
    coinbase: block.coinbase,
    transactions: block.transactions,
  });
}

export function decodeBlock(json: string): Block {
  const raw = JSON.parse(json) as Block & { header: { difficulty: string } };
  return {
    ...raw,
    nonce: Number(raw.nonce),
    header: { ...raw.header, difficulty: BigInt(raw.header.difficulty) },
  };
}

export class BlockchainStore {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (
        hash TEXT PRIMARY KEY,
        height INTEGER NOT NULL,
        previous_hash TEXT NOT NULL,
        total_work TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_height_idx ON blocks(height);
    `);
    const genesis = this.database.query('SELECT value FROM meta WHERE key = ?').get('genesis_hash') as { value: string } | null;
    if (!genesis) {
      this.database.query('INSERT INTO meta(key,value) VALUES(?,?)').run('genesis_hash', GENESIS_HASH);
    } else if (genesis.value !== GENESIS_HASH) {
      throw new Error('stored database belongs to a different EdgeX genesis');
    }
  }

  saveBlock(block: Block, totalWork: bigint): void {
    this.database.query('INSERT OR IGNORE INTO blocks VALUES(?,?,?,?,?)').run(
      block.hash,
      block.header.height,
      block.header.previousHash,
      totalWork.toString(),
      encodeBlock(block),
    );
  }

  allBlocksByHeight(): Array<{ block: Block; totalWork: bigint }> {
    const rows = this.database.query('SELECT hash,height,payload_json,total_work FROM blocks ORDER BY height ASC').all() as StoredBlockRow[];
    return rows.map((row) => ({ block: decodeBlock(row.payload_json), totalWork: BigInt(row.total_work) }));
  }

  count(): number {
    const row = this.database.query('SELECT COUNT(*) AS count FROM blocks').get() as { count: number };
    return row.count;
  }

  close(): void {
    this.database.close();
  }
}
