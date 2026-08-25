import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { t } from "../i18n";
import { MNEMONIC_FILE_NAME, VAULT_FILE_NAME } from "../config/config";


export const VAULT_MAGIC = "EDXWVLT";
export const VAULT_VERSION = 1;
export const VAULT_SALT_LEN = 16;
export const VAULT_IV_LEN = 12;
export const VAULT_TAG_LEN = 16;
export const MIN_PASSWORD_LENGTH = 4;
const LEGACY_SCRYPT_N = 32768;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function vaultFilePath(datadir: string): string {
  return path.join(datadir, VAULT_FILE_NAME);
}

export function legacyMnemonicFilePath(datadir: string): string {
  return path.join(datadir, MNEMONIC_FILE_NAME);
}

export function hasVault(datadir: string): boolean {
  return existsSync(vaultFilePath(datadir));
}

export function hasLegacyMnemonic(datadir: string): boolean {
  return existsSync(legacyMnemonicFilePath(datadir));
}


export function hasWalletFile(datadir: string): boolean {
  return hasVault(datadir) || hasLegacyMnemonic(datadir);
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function deriveKey(password: string, salt: Uint8Array, cost = SCRYPT_N): Uint8Array {
  return scryptSync(password, salt, 32, { N: cost, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
}


export function encryptMnemonic(mnemonic: string, password: string): Uint8Array {
  validatePassword(password);
  const salt = randomBytes(VAULT_SALT_LEN);
  const iv = randomBytes(VAULT_IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(mnemonic, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.concat([Buffer.from(VAULT_MAGIC, "ascii"), Buffer.from([VAULT_VERSION])]);
  return new Uint8Array(Buffer.concat([header, salt, iv, enc, tag]));
}


export function decryptMnemonic(data: Uint8Array, password: string): string {
  const buf = Buffer.from(data);
  const magic = Buffer.from(VAULT_MAGIC, "ascii");
  const minLen = magic.length + 1 + VAULT_SALT_LEN + VAULT_IV_LEN + VAULT_TAG_LEN;
  if (buf.length < minLen || !buf.subarray(0, magic.length).equals(magic)) {
    throw new Error("Wallet file corrupted or not an EDX wallet file");
  }
  const version = buf[magic.length];
  if (version !== VAULT_VERSION) {
    throw new Error(`Unsupported wallet file version: ${version}`);
  }
  let off = magic.length + 1;
  const salt = buf.subarray(off, off + VAULT_SALT_LEN);
  off += VAULT_SALT_LEN;
  const iv = buf.subarray(off, off + VAULT_IV_LEN);
  off += VAULT_IV_LEN;
  const tag = buf.subarray(buf.length - VAULT_TAG_LEN);
  const enc = buf.subarray(off, buf.length - VAULT_TAG_LEN);
  try {
    try {
      return decryptWith(deriveKey(password, salt, LEGACY_SCRYPT_N), iv, enc, tag).toString("utf8");
    } catch {
      return decryptWith(deriveKey(password, salt), iv, enc, tag).toString("utf8");
    }
  } catch {
    throw new Error("Wrong password or corrupted wallet file");
  }
}

function decryptWith(key: Uint8Array, iv: Uint8Array, enc: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function writeVaultFile(datadir: string, data: Uint8Array): void {
  mkdirSync(datadir, { recursive: true });
  writeFileSync(vaultFilePath(datadir), data, { mode: 0o600 });
}

export function readVaultFile(datadir: string): Uint8Array {
  return new Uint8Array(readFileSync(vaultFilePath(datadir)));
}

export function readLegacyMnemonic(datadir: string): string | null {
  const legacy = legacyMnemonicFilePath(datadir);
  if (!existsSync(legacy)) return null;
  return readFileSync(legacy, "utf8").trim();
}





export function migrateLegacyMnemonic(datadir: string, password: string): string | null {
  if (hasVault(datadir)) return null;
  const legacy = legacyMnemonicFilePath(datadir);
  if (!existsSync(legacy)) return null;
  const mnemonic = readFileSync(legacy, "utf8").trim();
  writeVaultFile(datadir, encryptMnemonic(mnemonic, password));
  renameSync(legacy, legacy + ".bak");
  return mnemonic;
}


const pendingLines: string[] = [];
const waiters: ((line: string) => void)[] = [];
let pumpStarted = false;

function startStdinPump(): void {
  if (pumpStarted) return;
  pumpStarted = true;
  void (async () => {
    try {
      for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        let parts = text.split(/\r?\n/);

        if (parts.length > 1 && text.endsWith("\n")) parts = parts.slice(0, -1);
        for (const part of parts) {
          const waiter = waiters.shift();
          if (waiter) waiter(part);
          else pendingLines.push(part);
        }
      }
    } catch {

    }
    for (const waiter of waiters.splice(0)) waiter("");
  })();
}

function readLineNonTty(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  startStdinPump();
  return new Promise((resolve) => {
    const ready = pendingLines.shift();
    if (ready !== undefined) {
      resolve(ready);
      return;
    }
    waiters.push(resolve);
  });
}


export function promptLine(promptText: string): Promise<string> {
  if (process.stdin.isTTY && process.stdout.isTTY) {

    const { createInterface } = require("node:readline") as typeof import("node:readline");
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
  return readLineNonTty(promptText);
}






export function promptSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return readLineNonTty(promptText);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\x03") {
          cleanup();
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}


export async function promptNewPassword(): Promise<string> {
  const first = await promptSecret(t("prompt.newPassword", { min: MIN_PASSWORD_LENGTH }));
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const second = await promptSecret(t("prompt.confirmPassword"));
  if (first !== second) {
    throw new Error("Passwords do not match");
  }
  return first;
}
