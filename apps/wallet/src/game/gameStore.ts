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
  /** 存档载荷：commKey 加密信封的 JSON 字符串；无密钥可用时原样（明文）存储 */
  payload: string | null;
  txid: string;
  createdAt: number;
}

/**
 * 本地游戏账本（datadir/game.db，SQLite）：游戏上传的分数/存档记录。
 * 去中心化版没有中心化后端承载游戏数据，上传记录落在钱包本地；
 * 每笔上传同时广播一笔小费交易上链（txid 为链上锚点），(gameId, uploadId) 唯一键保证幂等重试不重复扣费。
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

  /** 按 (gameId, uploadId) 幂等查找：命中即视为重复上传，重试不重复扣费。 */
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

  /** 写入一条上传记录（INSERT OR IGNORE：重复 uploadId 静默保留首条）。 */
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

  /** 排行榜：按分数降序（不含存档类记录），返回记录不含 payload 字段（隐私，仅 localhost 解密回传）。 */
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

  /** 最新存档（kind='save'）：供 save:get 取回后解密回传。 */
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