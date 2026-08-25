import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

export const GLOBAL_DB_MAGIC = "EDXGLDB1";
export const GLOBAL_KEY_MAGIC = "EDXGLKEY1";
export const GLOBAL_DB_IV_LENGTH = 12;
export const GLOBAL_DB_SCHEMA_VERSION = "1";

export class GlobalDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalDataError";
  }
}

function defaultDirectory(): string {
  return process.env.EDX_GLOBAL_DIR ?? path.join(os.homedir(), ".edgex-decentralized");
}

function encryptDatabase(bytes: Uint8Array, key: Buffer): Uint8Array {
  const iv = randomBytes(GLOBAL_DB_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from(GLOBAL_DB_MAGIC, "ascii"), iv, ciphertext, cipher.getAuthTag()]));
}

function decryptDatabase(data: Uint8Array, key: Buffer): Uint8Array {
  const buf = Buffer.from(data);
  if (!buf.subarray(0, GLOBAL_DB_MAGIC.length).equals(Buffer.from(GLOBAL_DB_MAGIC, "ascii"))) {
    throw new GlobalDataError("global database is corrupt");
  }
  const iv = buf.subarray(GLOBAL_DB_MAGIC.length, GLOBAL_DB_MAGIC.length + GLOBAL_DB_IV_LENGTH);
  const tag = buf.subarray(-16);
  const ciphertext = buf.subarray(GLOBAL_DB_MAGIC.length + GLOBAL_DB_IV_LENGTH, -16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new GlobalDataError("global database key mismatch or data is corrupt");
  }
}

/** Machine-wide encrypted key/value store. It deliberately contains no identity or telemetry. */
export class GlobalDataStore {
  private database: Database | null = null;

  constructor(
    private readonly filePath: string,
    private readonly keyPath: string,
  ) {}

  open(): { ok: boolean; created: boolean; error?: string } {
    try {
      this.close();
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      let key: Buffer;
      try {
        key = this.loadOrCreateKey();
      } catch (error) {
        return { ok: false, created: false, error: (error as Error).message };
      }
      if (!existsSync(this.filePath)) {
        this.database = new Database(":memory:");
        this.ensureSchema();
        this.setMeta("created_at", new Date().toISOString());
        this.save();
        return { ok: true, created: true };
      }
      let bytes: Uint8Array;
      try {
        bytes = decryptDatabase(new Uint8Array(readFileSync(this.filePath)), key);
      } catch (error) {
        return { ok: false, created: false, error: (error as Error).message };
      }
      this.database = new Database(bytes as unknown as string);
      this.ensureSchema();
      return { ok: true, created: false };
    } catch (error) {
      this.close();
      return { ok: false, created: false, error: (error as Error).message };
    }
  }

  private loadOrCreateKey(): Buffer {
    if (existsSync(this.keyPath)) {
      const raw = new Uint8Array(readFileSync(this.keyPath));
      const magic = Buffer.from(GLOBAL_KEY_MAGIC, "ascii");
      if (raw.length !== magic.length + 32 || !Buffer.from(raw.subarray(0, magic.length)).equals(magic)) {
        throw new GlobalDataError("global data key file is corrupt");
      }
      return Buffer.from(raw.subarray(magic.length));
    }
    mkdirSync(path.dirname(this.keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(this.keyPath, Buffer.concat([Buffer.from(GLOBAL_KEY_MAGIC, "ascii"), key]), { mode: 0o600 });
    return key;
  }

  private ensureSchema(): void {
    const db = this.requireDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.setMetaDirect("schema_version", GLOBAL_DB_SCHEMA_VERSION, Math.floor(Date.now() / 1000));
  }

  private requireDatabase(): Database {
    if (!this.database) throw new GlobalDataError("global database is not open");
    return this.database;
  }

  getMeta(key: string): string | null {
    const row = this.requireDatabase().query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.setMetaDirect(key, value, Date.now());
  }

  private setMetaDirect(key: string, value: string, updatedAt: number): void {
    this.requireDatabase().run(
      "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      [key, value, updatedAt],
    );
  }

  deleteMeta(key: string): void {
    this.requireDatabase().run("DELETE FROM meta WHERE key=?", [key]);
  }

  save(): void {
    const key = this.loadOrCreateKey();
    writeFileSync(this.filePath, encryptDatabase(this.requireDatabase().serialize(), key), { mode: 0o600 });
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }
}

let activeStore: GlobalDataStore | null = null;

export function initGlobalData(directory: string = defaultDirectory()): { ok: boolean; created: boolean; directory: string; error?: string } {
  activeStore?.close();
  const store = new GlobalDataStore(path.join(directory, "global.db"), path.join(directory, "global.key"));
  const result = store.open();
  activeStore = result.ok ? store : null;
  return { ...result, directory };
}

export function globalDataInitialized(): boolean {
  return activeStore !== null;
}

export function readGlobalData(key: string): string | null {
  return activeStore?.getMeta(key) ?? null;
}

export function writeGlobalData(key: string, value: string): void {
  if (!activeStore) return;
  activeStore.setMeta(key, value);
  activeStore.save();
}
