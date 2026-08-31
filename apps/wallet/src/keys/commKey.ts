import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decryptJson, encryptJson, generateKeyPair, type KeyPair } from "@edgex/shared";

/** ECIES communication key file name (datadir/comm.key, JSON, 0600). */
export const COMM_KEY_FILE_NAME = "comm.key";
const PRIVATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-fA-F]{64}$/;

/** Wallet ECIES communication key pair: independent of the HD address keys, used purely for communication encryption (game saves, etc.). */
export type CommKey = KeyPair;

export interface CommKeyOptions {
  onWarn?: (message: string) => void;
  /** Wallet password: when provided, the comm.key private key is encrypted to disk with scrypt + AES-256-GCM (v2); otherwise it stays plaintext (v1). */
  password?: string;
}

/** v2 encrypted file: the private key is encrypted with a password-derived key, the public key is plaintext (public). */
interface EncryptedCommKeyFile {
  v: 2;
  publicKeyHex: string;
  salt: string;
  iv: string;
  ct: string;
}

const COMM_KEY_VERSION = 2;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LEN = 16;
const IV_LEN = 12;

function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
}

/** Encrypts the private key into v2 file contents (returns a JSON object). */
export function encryptCommKeyFile(pair: KeyPair, password: string): EncryptedCommKeyFile {
  if (password.length < 1) throw new Error("Password must not be empty");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(pair.privateKeyHex, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: COMM_KEY_VERSION,
    publicKeyHex: pair.publicKeyHex,
    salt: Buffer.from(salt).toString("hex"),
    iv: Buffer.from(iv).toString("hex"),
    ct: Buffer.concat([enc, tag]).toString("hex"),
  };
}

/** Decrypts a v2 file; throws on wrong password or corrupted file. */
export function decryptCommKeyFile(data: EncryptedCommKeyFile, password: string): string {
  if (data.v !== COMM_KEY_VERSION) throw new Error(`Unsupported comm.key version: ${data.v}`);
  try {
    const salt = Buffer.from(data.salt, "hex");
    const iv = Buffer.from(data.iv, "hex");
    const raw = Buffer.from(data.ct, "hex");
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(0, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Wrong password or corrupted comm.key");
  }
}

function writeCommKey(datadir: string, pair: KeyPair, password?: string): void {
  mkdirSync(datadir, { recursive: true });
  const payload =
    password !== undefined ? JSON.stringify(encryptCommKeyFile(pair, password), null, 2) : JSON.stringify(pair, null, 2);
  writeFileSync(commKeyFilePath(datadir), payload + "\n", { mode: 0o600 });
}

export function commKeyFilePath(datadir: string): string {
  return path.join(datadir, COMM_KEY_FILE_NAME);
}

/** Validates the key pair: private/public key format + encrypt/decrypt round-trip self-check. */
export function isValidCommKey(pair: CommKey): boolean {
  if (!PRIVATE_KEY_PATTERN.test(pair.privateKeyHex)) return false;
  if (!PUBLIC_KEY_PATTERN.test(pair.publicKeyHex)) return false;
  try {
    decryptJson(encryptJson({ probe: 1 }, pair.publicKeyHex), pair.privateKeyHex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads or generates the wallet communication key (datadir/comm.key, 0600).
 * - v1 plaintext file: reused as-is once pairing checks pass; auto-migrated to v2 encryption when a password is provided (private key no longer stored in plaintext);
 * - v2 encrypted file: the correct password is required to unlock; throws without a password (caller degrades to an unencrypted session);
 * - missing file → generated and persisted (v2 with a password, v1 without); corrupted/unpaired → regenerated with a warning.
 */
export function loadOrCreateCommKey(datadir: string, opts: CommKeyOptions = {}): CommKey {
  const file = commKeyFilePath(datadir);
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      opts.onWarn?.("Corrupted communication key file; regenerated (comm.key)");
      raw = null;
    }
    if (raw !== null) {
      const obj = raw as Partial<KeyPair> & Partial<EncryptedCommKeyFile>;
      // v2 encrypted file: throw directly on wrong password/corruption (never silently rebuild, otherwise registered public keys become invalid)
      if (obj.v === COMM_KEY_VERSION) {
        if (opts.password === undefined) {
          throw new Error("comm.key is password-encrypted; unlock with the wallet password");
        }
        const pair: CommKey = {
          privateKeyHex: decryptCommKeyFile(obj as EncryptedCommKeyFile, opts.password),
          publicKeyHex: String(obj.publicKeyHex ?? ""),
        };
        if (!isValidCommKey(pair)) throw new Error("decrypted comm.key pair invalid");
        return pair;
      }
      // v1 plaintext: verify pairing; migrate to v2 when a password is provided
      const pair: CommKey = {
        privateKeyHex: String(obj.privateKeyHex ?? ""),
        publicKeyHex: String(obj.publicKeyHex ?? ""),
      };
      if (isValidCommKey(pair)) {
        if (opts.password !== undefined) writeCommKey(datadir, pair, opts.password);
        return pair;
      }
      opts.onWarn?.("Communication key file corrupted; regenerated (comm.key)");
    }
  }
  const pair = generateKeyPair();
  writeCommKey(datadir, pair, opts.password);
  return pair;
}