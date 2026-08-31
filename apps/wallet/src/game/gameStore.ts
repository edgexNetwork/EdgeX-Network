import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

export const GAME_DB_FILE_NAME = "game.db";

export interface GameUploadRecord {
  gameId: string;
  kind: string;
  uploadId: string;
  name: string | null;
  score: number | null;
  wave: number | null;
  lives: number | null;
  /** Save payload: JSON string of the commKey-encrypted envelope; stored as-is (plaintext) when no key is available */
  payload: string | null;
  txid: string;
  createdAt: number;
}

/**
 * Local game ledger (datadir/game.db, SQLite): score/save records uploaded by games.
 * The decentralized build has no central backend to host game data, so upload records live in the wallet;
 * every upload also broadcasts a tip transaction on-chain (txid is the on-chain anchor), and the
 * (gameId, uploadId) unique key makes retries idempotent so they never double-charge.
 */
export class GameStore {
  private db: Database;

  constructor(datadir: string) {
    mkdirSync(datadir, { recursive: true });
    this.db = new Database(path.join(datadir, GAME_DB_FILE_NAME));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS uploads (
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        name TEXT,
        score INTEGER,
        wave INTEGER,
        lives INTEGER,
        payload TEXT,
        txid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (game_id, upload_id)
      )
    `);
  }

  /** Idempotent lookup by (gameId, uploadId): a hit counts as a duplicate upload, so retries never double-charge. */
  findByUploadId(gameId: string, uploadId: string): GameUploadRecord | null {
    if (uploadId === "") return null;
    const row = this.db
      .query(
        `SELECT game_id AS gameId, kind, upload_id AS uploadId, name, score, wave, lives, payload, txid, created_at AS createdAt
         FROM uploads WHERE game_id = ? AND upload_id = ?`,
      )
      .get(gameId, uploadId) as GameUploadRecord | null;
    return row ?? null;
  }

  /** Inserts one upload record (INSERT OR IGNORE: duplicate uploadId silently keeps the first row). */
  insert(record: GameUploadRecord): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO uploads (game_id, kind, upload_id, name, score, wave, lives, payload, txid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.gameId,
        record.kind,
        record.uploadId,
        record.name,
        record.score,
        record.wave,
        record.lives,
        record.payload,
        record.txid,
        record.createdAt,
      );
  }

  /** Leaderboard: score descending (save-kind records excluded); returned rows omit the payload field (privacy — decrypted only locally over localhost). */
  leaderboard(gameId: string, limit: number): GameUploadRecord[] {
    const rows = this.db
      .query(
        `SELECT game_id AS gameId, kind, upload_id AS uploadId, name, score, wave, lives, txid, created_at AS createdAt
         FROM uploads
         WHERE game_id = ? AND kind != 'save'
         ORDER BY score DESC, created_at ASC
         LIMIT ?`,
      )
      .all(gameId, Math.max(1, Math.floor(limit))) as GameUploadRecord[];
    return rows;
  }

  /** Latest save (kind='save'): fetched by save:get, decrypted and returned. */
  findSave(gameId: string): GameUploadRecord | null {
    const row = this.db
      .query(
        `SELECT game_id AS gameId, kind, upload_id AS uploadId, name, score, wave, lives, payload, txid, created_at AS createdAt
         FROM uploads WHERE game_id = ? AND kind = 'save'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(gameId) as GameUploadRecord | null;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}