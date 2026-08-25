import { HDKey } from "@scure/bip32";
import { renameSync } from "node:fs";
import { t } from "../i18n";
import { ADDRESS_VERSION, DEFAULT_DERIVATION_PATH } from "../utils/constants";
import { base58CheckEncode, hash160 } from "../utils/base58";
import { isValidMnemonic, mnemonicToSeed, normalizeMnemonic, generateMnemonicWords } from "./mnemonic";
import {
  decryptMnemonic,
  encryptMnemonic,
  hasLegacyMnemonic,
  hasVault,
  legacyMnemonicFilePath,
  migrateLegacyMnemonic,
  promptSecret,
  readLegacyMnemonic,
  readVaultFile,
  vaultFilePath,
  writeVaultFile,
} from "./vaultLegacy";

export interface WalletKey {
  mnemonic: string;
  derivationPath: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}


export function deriveWalletKey(mnemonic: string): WalletKey {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(normalized)) throw new Error("Invalid BIP39 mnemonic");
  const seed = mnemonicToSeed(normalized);
  const hd = HDKey.fromMasterSeed(seed).derive(DEFAULT_DERIVATION_PATH);
  const privateKey = hd.privateKey;
  const publicKey = hd.publicKey;
  if (!privateKey || !publicKey) throw new Error("Key derivation failed");
  const address = base58CheckEncode(ADDRESS_VERSION, hash160(publicKey));
  return {
    mnemonic: normalized,
    derivationPath: DEFAULT_DERIVATION_PATH,
    privateKey,
    publicKey,
    address,
  };
}


export function mnemonicFilePath(datadir: string): string {
  return legacyMnemonicFilePath(datadir);
}

export interface CreateWalletOptions {

  password: string;

  mnemonic?: string;

  force?: boolean;

  context?: string;
}

export interface CreateWalletResult {
  key: WalletKey;
  created: boolean;
  migrated: boolean;
}








export function createOrLoadKey(datadir: string, opts: CreateWalletOptions): CreateWalletResult {
  if (opts.mnemonic !== undefined && !isValidMnemonic(opts.mnemonic)) {
    throw new Error("Invalid BIP39 mnemonic; check the words and spelling");
  }
  if (hasVault(datadir) && !opts.force) {
    const mnemonic = decryptMnemonic(readVaultFile(datadir), opts.password);
    return { key: deriveWalletKey(mnemonic), created: false, migrated: false };
  }
  if (!hasVault(datadir) && hasLegacyMnemonic(datadir) && !opts.force) {
    const migrated = migrateLegacyMnemonic(datadir, opts.password);
    if (migrated !== null) {
      return { key: deriveWalletKey(migrated), created: false, migrated: true };
    }
  }

  if (opts.force && !hasVault(datadir) && hasLegacyMnemonic(datadir)) {
    renameSync(legacyMnemonicFilePath(datadir), legacyMnemonicFilePath(datadir) + ".bak");
  }
  const mnemonic = opts.mnemonic !== undefined ? normalizeMnemonic(opts.mnemonic) : generateMnemonicWords(256);
  writeVaultFile(datadir, encryptMnemonic(mnemonic, opts.password));
  return { key: deriveWalletKey(mnemonic), created: true, migrated: false };
}


export function loadWalletKey(datadir: string, password: string): WalletKey {
  if (hasVault(datadir)) {
    const data = readVaultFile(datadir);
    if (!verifyVaultPassword(data, password)) {
      throw new Error("Wrong password or corrupted wallet file");
    }
    return deriveWalletKey(decryptMnemonic(data, password));
  }
  const legacy = readLegacyMnemonic(datadir);
  if (legacy !== null) {
    const migrated = migrateLegacyMnemonic(datadir, password);
    if (migrated !== null) return deriveWalletKey(migrated);
  }
  throw new Error(`Wallet not found: ${vaultFilePath(datadir)}`);
}


export function verifyVaultPassword(data: Uint8Array, password: string): boolean {
  try {
    decryptMnemonic(data, password);
    return true;
  } catch {
    return false;
  }
}


export const MAX_PASSWORD_ATTEMPTS = 5;


export class PasswordError extends Error {}

export interface LoadWalletRetryOptions {

  maxAttempts?: number;

  interactive?: boolean;

  getPassword?: (prompt: string) => Promise<string>;
}








export async function loadWalletWithRetry(
  datadir: string,
  opts: LoadWalletRetryOptions = {},
): Promise<{ key: WalletKey; password: string }> {
  const getPassword = opts.getPassword ?? promptSecret;
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const envPassword = process.env.EDX_WALLET_PASSWORD;
  if (envPassword) {
    return { key: loadWalletKey(datadir, envPassword), password: envPassword };
  }
  const maxAttempts = interactive ? (opts.maxAttempts ?? MAX_PASSWORD_ATTEMPTS) : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? t("prompt.walletPassword")
        : t("prompt.walletPasswordRetry", { attempt, max: maxAttempts });
    const password = await getPassword(prompt);
    try {
      const key = loadWalletKey(datadir, password);
      return { key, password };
    } catch (e) {
      lastError = e;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  if (maxAttempts === 1) throw new PasswordError(detail);
  throw new PasswordError(`Wrong password (${maxAttempts} attempts): ${detail}`);
}
