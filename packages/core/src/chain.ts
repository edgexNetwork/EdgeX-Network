import {
  LWMA_WINDOW,
  TIMESTAMP_FUTURE_TOLERANCE_MS,
  transactionId,
} from '@edgex/shared';
import { calculateMerkleRoot, serializeMiningBlob, serializedBlockBodyLength } from './block';
import { GENESIS_HASH, createGenesisBlock } from './genesis';
import { nextLwmaDifficulty } from './difficulty';
import { workForDifficulty, type PowVerifier } from './pow';
import { expectedSeedHeight } from './schedule';
import { UtxoState } from './state';
import type { Block, BlockHeader, ChainWorkSummary } from './types';

export const MAX_BLOCK_BODY_BYTES = 2_000_000;

export class ChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainValidationError';
  }
}

interface ChainEntry {
  block: Block;
  state: UtxoState;
  totalWork: bigint;
}

export interface NextConsensusData {
  height: number;
  difficulty: bigint;
  powSeed: string;
}

/** Full in-memory consensus with cumulative-work fork choice. */
export class ConsensusChain {
  private readonly entries = new Map<string, ChainEntry>();
  private bestHash = GENESIS_HASH;
  private readonly nowMs: () => number;

  constructor(
    private readonly verifier: PowVerifier,
    nowMs: () => number = () => Date.now(),
  ) {
    this.nowMs = nowMs;
    const genesis = createGenesisBlock();
    if (genesis.hash !== GENESIS_HASH) throw new ChainValidationError('genesis hash mismatch');
    this.entries.set(GENESIS_HASH, { block: genesis, state: new UtxoState(), totalWork: workForDifficulty(genesis.header.difficulty) });
  }

  get bestBlockHash(): string {
    return this.bestHash;
  }

  get height(): number {
    return this.get(this.bestHash).block.header.height;
  }

  get totalIssued(): bigint {
    return this.get(this.bestHash).state.totalIssued;
  }

  get(hashHex: string): ChainEntry {
    const entry = this.entries.get(hashHex);
    if (!entry) throw new ChainValidationError(`unknown block ${hashHex}`);
    return entry;
  }

  has(hashHex: string): boolean {
    return this.entries.has(hashHex);
  }

  stateAt(hashHex: string): UtxoState {
    return this.get(hashHex).state.clone();
  }

  /** Blocks on the current best chain, ordered from genesis to the tip. */
  bestChainBlocks(): Block[] {
    return this.ancestry(this.bestHash);
  }

  /** Block at the given height on the current best chain, or null when that height is not stored. */
  chainAtHeight(height: number): Block | null {
    if (!Number.isSafeInteger(height) || height < 0) return null;
    const path = this.ancestry(this.bestHash);
    return path[height] ?? null;
  }

  /** Cumulative chain work up to the block at the given best-chain height, or null when out of range. */
  cumulativeWorkAt(height: number): bigint | null {
    const block = this.chainAtHeight(height);
    if (!block) return null;
    return this.get(block.hash).totalWork;
  }

  nextConsensusData(): NextConsensusData {
    const parent = this.get(this.bestHash).block;
    const nextHeight = parent.header.height + 1;
    const seedHeight = expectedSeedHeight(nextHeight);
    const seedBlock = this.ancestor(parent.hash, seedHeight);
    return {
      height: nextHeight,
      difficulty: nextLwmaDifficulty(this.recentSummaries(parent.hash)),
      powSeed: this.headerHash(seedBlock),
    };
  }

  addBlock(block: Block): 'extended' | 'fork' | 'known' {
    if (!/^[0-9a-f]{64}$/.test(block.hash)) throw new ChainValidationError('invalid block hash encoding');
    if (this.has(block.hash)) return 'known';
    if (serializedBlockBodyLength(block) > MAX_BLOCK_BODY_BYTES) {
      throw new ChainValidationError('block body exceeds maximum size');
    }

    const parentEntry = this.entries.get(block.header.previousHash);
    if (!parentEntry) throw new ChainValidationError('unknown previous block');
    const parent = parentEntry.block;
    this.validateLink(parent, block);

    const txids = block.transactions.map((transaction, index) => {
      try {
        // transactionId is imported indirectly to keep core's public surface small.
        return transactionId(transaction);
      } catch (error) {
        throw new ChainValidationError(`transaction ${index}: ${(error as Error).message}`);
      }
    });
    const expectedMerkle = calculateMerkleRoot(block.header.height, block.coinbase, txids);
    if (expectedMerkle !== block.header.merkleRoot) throw new ChainValidationError('merkle root mismatch');
    if (block.coinbase && block.coinbase.outputs[0]?.address !== block.header.payoutAddress) {
      throw new ChainValidationError('payout commitment does not match coinbase');
    }

    const blob = serializeMiningBlob(block.header, block.nonce);
    if (!this.verifier.verify(blob, block.hash, block.header.difficulty)) {
      throw new ChainValidationError('invalid proof of work');
    }

    const state = parentEntry.state.clone();
    state.applyBlock(block);
    const totalWork = parentEntry.totalWork + workForDifficulty(block.header.difficulty);
    this.entries.set(block.hash, { block, state, totalWork });

    if (totalWork > this.get(this.bestHash).totalWork) {
      this.bestHash = block.hash;
      return 'extended';
    }
    return 'fork';
  }

  private validateLink(parent: Block, block: Block): void {
    const header = block.header;
    if (header.version !== parent.header.version) throw new ChainValidationError('unsupported version');
    if (header.height !== parent.header.height + 1) throw new ChainValidationError('height is not sequential');

    const summaries = this.recentSummaries(parent.hash);
    const expectedDifficulty = nextLwmaDifficulty(summaries);
    if (header.difficulty !== expectedDifficulty) {
      throw new ChainValidationError(`difficulty mismatch: expected ${expectedDifficulty}`);
    }

    const nextHeight = header.height;
    const seedBlock = this.ancestor(parent.hash, expectedSeedHeight(nextHeight));
    const expectedSeed = this.headerHash(seedBlock);
    if (header.powSeed !== expectedSeed) throw new ChainValidationError('PoW key epoch mismatch');

    const timestamps = [...this.ancestry(parent.hash).slice(-11)].map((block) => block.header.timestampSeconds);
    const median = medianOf(timestamps);
    if (header.timestampSeconds <= median) throw new ChainValidationError('timestamp not newer than median');
    if (BigInt(header.timestampSeconds) * 1000n > BigInt(this.nowMs() + TIMESTAMP_FUTURE_TOLERANCE_MS)) {
      throw new ChainValidationError('timestamp too far in future');
    }
  }

  private ancestry(startHash: string): Block[] {
    const result: Block[] = [];
    let hash = startHash;
    while (true) {
      const entry = this.entries.get(hash);
      if (!entry) break;
      result.push(entry.block);
      if (entry.block.header.height === 0) break;
      hash = entry.block.header.previousHash;
    }
    return result.reverse();
  }

  /**
   * Canonical path of the block with the given hash, ordered from genesis to
   * that block. Returns null when the hash is unknown.
   */
  pathFrom(startHash: string): Block[] | null {
    if (!this.entries.has(startHash)) return null;
    return this.ancestry(startHash);
  }

  /** Cumulative chain work up to the block with the given hash, or null when unknown. */
  cumulativeWorkFrom(startHash: string): bigint | null {
    const entry = this.entries.get(startHash);
    if (!entry) return null;
    return entry.totalWork;
  }

  private ancestor(startHash: string, height: number): Block {
    let block = this.get(startHash).block;
    while (block.header.height > height) {
      const parent = this.entries.get(block.header.previousHash);
      if (!parent) throw new ChainValidationError('chain ended before requested ancestor');
      block = parent.block;
    }
    if (block.header.height !== height) throw new ChainValidationError('requested ancestor before genesis');
    return block;
  }

  private recentSummaries(startHash: string): ChainWorkSummary[] {
    return this.ancestry(startHash)
      .slice(-LWMA_WINDOW)
      .map((block) => ({
        height: block.header.height,
        timestampSeconds: block.header.timestampSeconds,
        difficulty: block.header.difficulty,
      }));
  }

  private headerHash(block: Block): string {
    return block.hash;
  }
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

// Keep a tiny wrapper here so tests can monkey-patch shared behavior without
// exposing every shared function through the chain API.
