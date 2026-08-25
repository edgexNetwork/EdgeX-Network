import { INITIAL_DIFFICULTY, NETWORK_ID, PROTOCOL_VERSION } from '@edgex/shared';
import { sha256Hex } from '@edgex/shared';
import { serializeHeader } from './block';
import type { Block } from './types';

export const GENESIS_TIMESTAMP_SECONDS = 1_767_225_600; // 2026-01-01T00:00:00Z.
export const GENESIS_POW_SEED = sha256Hex(new TextEncoder().encode(`${NETWORK_ID}:seed-epoch-0`));

export function createGenesisBlock(): Block {
  const header = {
    version: PROTOCOL_VERSION,
    height: 0,
    previousHash: '0'.repeat(64),
    timestampSeconds: GENESIS_TIMESTAMP_SECONDS,
    difficulty: INITIAL_DIFFICULTY,
    merkleRoot: '0'.repeat(64),
    powSeed: GENESIS_POW_SEED,
    payoutAddress: '',
  };
  const block: Block = {
    header,
    hash: sha256Hex(serializeHeader(header, 0)),
    nonce: 0,
    coinbase: null,
    transactions: [],
  };
  Object.freeze(block.transactions);
  return block;
}

export const GENESIS_BLOCK = createGenesisBlock();
export const GENESIS_HASH = GENESIS_BLOCK.hash;
