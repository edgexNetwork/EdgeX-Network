import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decryptJson, encryptJson, generateKeyPair, type KeyPair } from "@edgex/shared";

/** ECIES 通讯密钥文件名（datadir/comm.key，JSON，0600）。 */
export const COMM_KEY_FILE_NAME = "comm.key";
const PRIVATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-fA-F]{64}$/;

/** 钱包 ECIES 通讯密钥对：独立于 HD 地址密钥，专门用于通讯加解密（游戏存档等）。 */
export type CommKey = KeyPair;

export interface CommKeyOptions {
  onWarn?: (message: string) => void;
  /** 钱包密码：提供时 comm.key 私钥以 scrypt + AES-256-GCM 加密落盘（v2），未提供保持明文 v1。 */
  password?: string;
}

/** v2 加密文件：私钥用密码派生密钥加密，公钥明文（公钥公开）。 */
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

/** 加密私钥为 v2 文件内容（返回 JSON 对象）。 */
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

/** 解密 v2 文件；密码错误或文件损坏抛错。 */
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

/** 校验密钥对：私钥/公钥格式 + 加密解密往返自检。 */
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
 * 加载或生成钱包通讯密钥（datadir/comm.key，0600）。
 * - v1 明文文件：配对校验通过直接复用；提供密码时自动迁移为 v2 加密（私钥不再明文落盘）；
 * - v2 加密文件：必须提供正确密码解锁；无密码抛错（调用方降级为不加密会话）；
 * - 文件缺失 → 生成并持久化（有密码写 v2，无密码写 v1）；损坏/不配对 → 重新生成并警告。
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
      // v2 加密文件：密码错误/损坏直接抛错（绝不静默重建，否则已注册公钥失效）
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
      // v1 明文：校验配对；提供密码时迁移为 v2
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