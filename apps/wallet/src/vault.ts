import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WalletKey } from './wallet';
import { walletFromMnemonic } from './wallet';

const MAGIC = 'EDXWALLET1';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export function saveWalletVault(path: string, key: WalletKey, password: string): void {
  if (password.length < 8) throw new Error('wallet password must contain at least eight characters');
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const encryptionKey = scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const plaintext = Buffer.from(JSON.stringify(key), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  mkdirSync(dirname(path), { recursive: true });
  const encoded = Buffer.concat([salt, iv, ciphertext]).toString('base64');
  writeFileSync(path, `${MAGIC}:${encoded}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function loadWalletVault(path: string, password: string): WalletKey {
  const raw = readFileSync(path, 'utf8').trim();
  const [magic, encoded] = raw.split(':');
  if (magic !== MAGIC || !encoded) throw new Error('not an EdgeX encrypted wallet vault');
  const payload = Buffer.from(encoded, 'base64');
  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const sealed = payload.subarray(SALT_LENGTH + IV_LENGTH);
  if (sealed.length <= 16) throw new Error('wallet vault is truncated');
  const ciphertext = sealed.subarray(0, -16);
  const authTag = sealed.subarray(-16);
  const encryptionKey = scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return walletFromMnemonic((JSON.parse(plaintext.toString('utf8')) as WalletKey).mnemonic);
  } catch {
    throw new Error('wrong wallet password or corrupted vault');
  }
}
