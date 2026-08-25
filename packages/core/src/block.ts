import {
  MAX_TX_INPUTS,
  MINING_NONCE_OFFSET,
  PROTOCOL_VERSION,
  concatBytes,
  hexToBytes,
  sha256,
  validateAddress,
} from '@edgex/shared';
import { parseEdxAmount } from '@edgex/shared';
import { ByteWriter } from './encoding';
import type { Block, BlockHeader, CoinbaseTransaction } from './types';

const DOMAIN_VERSION = 1;
const DOMAIN_SELECTOR = 0xed;

function hexToBytes32(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid ${label}`);
  return hexToBytes(value);
}

/**
 * Serialize the consensus header. The first 43 bytes intentionally mirror the
 * Monero nonce layout so common RandomX miners can consume the blob unchanged.
 */
export function serializeHeader(header: BlockHeader, nonce: number): Uint8Array {
  if (header.version !== PROTOCOL_VERSION) throw new Error('unsupported header version');
  if (!Number.isSafeInteger(header.height) || header.height < 0) throw new Error('invalid block height');
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > 0xffffffff) throw new Error('invalid nonce');
  if (!Number.isSafeInteger(header.timestampSeconds) || header.timestampSeconds < 0 || header.timestampSeconds > 0xffffffff) {
    throw new Error('invalid block timestamp');
  }
  if (header.difficulty < 1n || header.difficulty >= 1n << 128n) throw new Error('difficulty outside u128');

  return new ByteWriter()
    .u8(DOMAIN_VERSION)
    .u8(DOMAIN_SELECTOR)
    .u32le(header.timestampSeconds)
    .bytes(hexToBytes32(header.previousHash, 'previous hash'))
    .u8(0)
    .u32le(nonce)
    .u32(header.height)
    .u128(header.difficulty)
    .bytes(hexToBytes32(header.merkleRoot, 'merkle root'))
    .bytes(hexToBytes32(header.powSeed, 'PoW seed'))
    .ascii(header.payoutAddress)
    .toBytes();
}

export function serializeMiningBlob(header: BlockHeader, nonce: number): Uint8Array {
  const blob = serializeHeader(header, nonce);
  // Explicitly verify the compatibility contract rather than relying on edits.
  const expectedOffset =
    1 + // version
    1 + // domain selector
    4 + // timestamp
    32 + // parent
    1 + // reserved
    0;
  if (expectedOffset !== MINING_NONCE_OFFSET) throw new Error('nonce offset mismatch');
  return blob;
}

export function writeNonce(blob: Uint8Array, nonce: number): Uint8Array {
  const result = blob.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(MINING_NONCE_OFFSET, nonce, true);
  return result;
}

export function readNonce(blob: Uint8Array): number {
  if (blob.length <= MINING_NONCE_OFFSET + 3) throw new Error('mining blob too short');
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return view.getUint32(MINING_NONCE_OFFSET, true);
}

export function coinbaseId(blockHeight: number, coinbase: CoinbaseTransaction): string {
  const outputText = coinbase.outputs.map((output) => `${output.address}:${parseEdxAmount(output.amount)}`).join('|');
  return sha256HexText(`EDX-coinbase-v1\0${blockHeight}\0${outputText}`);
}

export function transactionLeaf(txid: string): Uint8Array {
  return sha256(concatBytes(new TextEncoder().encode('EDX-tx-v1\0'), hexToBytes(txid)));
}

export function calculateMerkleRoot(blockHeight: number, coinbase: CoinbaseTransaction | null, txids: readonly string[]): string {
  const leaves: Uint8Array[] = [];
  if (coinbase) leaves.push(hexToBytes(coinbaseId(blockHeight, coinbase)));
  for (const txid of txids) leaves.push(transactionLeaf(txid));
  const countPrefix = new Uint8Array(4);
  new DataView(countPrefix.buffer).setUint32(0, leaves.length, false);
  const leafData = leaves.length === 0 ? new Uint8Array(0) : concatBytes(...leaves);
  return sha256HexText(`EDX-merkle-v1\0${blockHeight}`, concatBytes(countPrefix, leafData));
}

export function serializedBlockBodyLength(block: Block): number {
  let length = 4; // transaction count
  for (const transaction of block.transactions) {
    length += 4;
    length += transaction.inputs.length * 36;
    for (const output of transaction.outputs) {
      length += 1 + output.address.length + 8;
    }
    length += 8 + 66 + 64;
  }
  return length;
}

function sha256HexText(text: string, additional?: Uint8Array): string {
  const encoded = new TextEncoder().encode(text);
  const payload = additional ? concatBytes(encoded, additional) : encoded;
  const digest = sha256(payload);
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
