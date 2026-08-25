import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ADDRESS_HASH_LENGTH, ADDRESS_VERSION } from '../constants';
import { base58CheckDecode, base58CheckEncode } from './base58';
import { bytesToHex, hash160, hexToBytes, sha256, sha256Hex } from './hash';

export interface KeyPair {
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface TransactionOutputLike {
  address: string;
  amount: string;
}

export interface TransactionInputLike {
  txid: string;
  index: number;
}

export interface TransactionLike {
  inputs: TransactionInputLike[];
  outputs: TransactionOutputLike[];
  fee: string;
}

/** Preserve the exact centralized-era signing format so wallets remain compatible. */
export function transactionInputsText(inputs: readonly TransactionInputLike[]): string {
  return inputs.map((input, index) => `input:${index}:${input.txid}:${input.index}`).join('\n');
}

export function transactionOutputsText(outputs: readonly TransactionOutputLike[]): string {
  return outputs.map((output, index) => `${index}:${output.address}:${output.amount}`).join('\n');
}

export function transactionMessage(transaction: TransactionLike): string {
  return [
    transactionInputsText(transaction.inputs),
    `fee:${transaction.fee}`,
    transactionOutputsText(transaction.outputs),
  ].join('\n');
}

export function transactionMessageHash(transaction: TransactionLike): string {
  return sha256Hex(transactionMessage(transaction));
}

export function addressFromPublicKey(publicKeyHex: string): string {
  const publicKey = hexToBytes(publicKeyHex);
  const payload = new Uint8Array([ADDRESS_VERSION, ...hash160(publicKey)]);
  return base58CheckEncode(payload);
}

export function validateAddress(address: string): boolean {
  try {
    const decoded = base58CheckDecode(address);
    return decoded.version === ADDRESS_VERSION && decoded.payload.length === ADDRESS_HASH_LENGTH;
  } catch {
    return false;
  }
}

export function generateKeyPair(): KeyPair {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

export function signMessage(privateKeyHex: string, message: Uint8Array | string): string {
  const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const signature = secp256k1.sign(sha256(messageBytes), hexToBytes(privateKeyHex), {
    prehash: false,
  });
  return bytesToHex(signature);
}

export function verifySignature(publicKeyHex: string, message: Uint8Array | string, signatureHex: string): boolean {
  try {
    const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    return secp256k1.verify(hexToBytes(signatureHex), sha256(messageBytes), hexToBytes(publicKeyHex), {
      prehash: false,
    });
  } catch {
    return false;
  }
}

export function signTransaction<T extends TransactionLike>(transaction: T, privateKeyHex: string): T & { pubkey: string; signature: string } {
  const publicKey = secp256k1.getPublicKey(hexToBytes(privateKeyHex), true);
  return {
    ...transaction,
    pubkey: bytesToHex(publicKey),
    signature: signMessage(privateKeyHex, transactionMessage(transaction)),
  };
}

export function signedTransactionId(transaction: TransactionLike & { signature: string }): string {
  const payload = `${transactionMessage(transaction)}\n${transaction.signature}`;
  return sha256Hex(payload);
}
