import { sha256, TARGET_BLOCK_SECONDS } from '@edgex/shared';

/** A verifier both recomputes the PoW and checks it against consensus target. */
export interface PowVerifier {
  verify(miningBlob: Uint8Array, claimedHashHex: string, difficulty: bigint): boolean;
}

export interface PowHasher {
  hash(input: Uint8Array): string;
}

const MAX_TARGET = (1n << 256n) - 1n;

export function targetForDifficulty(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new RangeError('difficulty must be positive');
  const target = MAX_TARGET / difficulty;
  return target > MAX_TARGET ? MAX_TARGET : target;
}

/** RandomX results are interpreted little-endian by Monero-compatible miners. */
export function hashMeetsTarget(hashHex: string, difficulty: bigint): boolean {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) return false;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hashHex.slice(index * 2, index * 2 + 2), 16);
  }
  let value = 0n;
  for (let index = 31; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]!);
  return value <= targetForDifficulty(difficulty);
}

/** Deterministic test/dev hasher; never enable as the mainnet consensus verifier. */
export class Sha256PowVerifier implements PowVerifier {
  constructor(private readonly hasher: PowHasher = { hash: (input) => bytesToHexLocal(sha256(input)) }) {}

  verify(miningBlob: Uint8Array, claimedHashHex: string, difficulty: bigint): boolean {
    const actual = this.hasher.hash(miningBlob);
    return actual === claimedHashHex && hashMeetsTarget(actual, difficulty);
  }
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function workForDifficulty(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new RangeError('difficulty must be positive');
  return MAX_TARGET / difficulty + 1n;
}

/**
 * Estimate nominal network hash rate from difficulty and the target block period.
 * This is a display metric only; it does not participate in consensus validation.
 */
export function estimateNetworkHashps(difficulty: bigint): number {
  if (difficulty < 1n) throw new RangeError('difficulty must be positive');
  return Math.max(0, Math.round(Number(difficulty) / Number(TARGET_BLOCK_SECONDS)));
}
