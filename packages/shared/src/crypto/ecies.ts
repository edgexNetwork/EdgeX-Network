import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateKeyPair, signMessage, verifySignature, type KeyPair } from './keys';
import { bytesToHex, hexToBytes } from './hash';

export const ECIES_ALGORITHM = 'ecies-secp256k1-aes-256-gcm';
export const ECIES_VERSION = 1;

const HKDF_INFO = new TextEncoder().encode('edx-ecies-v1');
const HKDF_SALT = new Uint8Array(32);
const HKDF_LENGTH = 32;
const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export interface EncryptedMessage {
  v: number;
  alg: string;
  epk: string;
  nonce: string;
  ct: string;
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function deriveSharedKey(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(
    hexToBytes(privateKeyHex),
    hexToBytes(publicKeyHex),
    true,
  );
  const sharedX = sharedPoint.slice(-32);
  return hkdf(sha256, sharedX, HKDF_SALT, HKDF_INFO, HKDF_LENGTH);
}

export function encryptMessage(
  recipientPublicKeyHex: string,
  message: Uint8Array | string,
): EncryptedMessage {
  const ephemeral = generateKeyPair();
  const key = deriveSharedKey(ephemeral.privateKeyHex, recipientPublicKeyHex);
  const nonce = randomBytes(NONCE_LENGTH);
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const cipher = gcm(key, nonce);
  return {
    v: ECIES_VERSION,
    alg: ECIES_ALGORITHM,
    epk: ephemeral.publicKeyHex,
    nonce: bytesToHex(nonce),
    ct: bytesToHex(cipher.encrypt(data)),
  };
}

export function decryptMessage(envelope: EncryptedMessage, privateKeyHex: string): Uint8Array {
  if (envelope.v !== ECIES_VERSION || envelope.alg !== ECIES_ALGORITHM) {
    throw new DecryptionError(`unsupported envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  try {
    const key = deriveSharedKey(privateKeyHex, envelope.epk);
    const cipher = gcm(key, hexToBytes(envelope.nonce));
    return cipher.decrypt(hexToBytes(envelope.ct));
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError('decryption failed');
  }
}

export function encryptJson<T>(payload: T, recipientPublicKeyHex: string): EncryptedMessage {
  return encryptMessage(recipientPublicKeyHex, JSON.stringify(payload));
}

export function decryptJson<T>(envelope: EncryptedMessage, privateKeyHex: string): T {
  const plaintext = decryptMessage(envelope, privateKeyHex);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function signEnvelope(envelope: EncryptedMessage, privateKeyHex: string): string {
  return signMessage(privateKeyHex, canonicalEnvelope(envelope));
}

export function verifyEnvelope(
  envelope: EncryptedMessage,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  return verifySignature(publicKeyHex, canonicalEnvelope(envelope), signatureHex);
}

function canonicalEnvelope(envelope: EncryptedMessage): string {
  return `${envelope.v}.${envelope.alg}.${envelope.epk}.${envelope.nonce}.${envelope.ct}`;
}

export function ciphertextLength(plaintextLength: number): number {
  return plaintextLength + GCM_TAG_LENGTH;
}