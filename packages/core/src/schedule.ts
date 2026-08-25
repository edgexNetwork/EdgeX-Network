import { RANDOMX_KEY_EPOCH_BLOCKS, RANDOMX_SEED_DELAY } from '@edgex/shared';

export function epochIndexForNextBlock(nextHeight: number): number {
  if (!Number.isSafeInteger(nextHeight) || nextHeight < 1) throw new RangeError('next block height must be positive');
  return Math.floor((nextHeight - 1) / RANDOMX_KEY_EPOCH_BLOCKS);
}

/** Return zero during bootstrap; otherwise choose an already-buried epoch header. */
export function seedHeightForEpoch(epochIndex: number): number {
  if (!Number.isSafeInteger(epochIndex) || epochIndex < 0) throw new RangeError('invalid epoch index');
  if (epochIndex === 0) return 0;
  const firstHeightInEpoch = epochIndex * RANDOMX_KEY_EPOCH_BLOCKS + 1;
  return Math.max(0, firstHeightInEpoch - 1 - RANDOMX_SEED_DELAY);
}

export function expectedSeedHeight(nextHeight: number): number {
  return seedHeightForEpoch(epochIndexForNextBlock(nextHeight));
}
