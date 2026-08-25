import {
  INITIAL_DIFFICULTY,
  LWMA_WINDOW,
  MAX_TIMESTAMP_DROP_MULTIPLIER,
  MINIMUM_DIFFICULTY,
  TARGET_BLOCK_SECONDS,
} from '@edgex/shared';
import type { ChainWorkSummary } from './types';

export class DifficultyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DifficultyError';
  }
}

function boundedSolveTime(previous: ChainWorkSummary, current: ChainWorkSummary): bigint {
  const solveTime = BigInt(current.timestampSeconds - previous.timestampSeconds);
  const minimum = 1n;
  const maximum = TARGET_BLOCK_SECONDS * MAX_TIMESTAMP_DROP_MULTIPLIER;
  if (solveTime < minimum) return minimum;
  return solveTime > maximum ? maximum : solveTime;
}

/**
 * Compute the next difficulty with a front-weighted linear moving average.
 * The caller must pass the most recent window items in chain order.
 */
export function nextLwmaDifficulty(recent: readonly ChainWorkSummary[]): bigint {
  if (recent.length === 0) return INITIAL_DIFFICULTY;
  if (recent.length < LWMA_WINDOW) return recent[recent.length - 1]!.difficulty;

  const window = recent.slice(-LWMA_WINDOW);
  let weightedSolveTime = 0n;
  let difficultySum = 0n;
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    if (current.timestampSeconds <= previous.timestampSeconds) throw new DifficultyError('block timestamps must increase');
    weightedSolveTime += boundedSolveTime(previous, current) * BigInt(index);
    difficultySum += current.difficulty;
  }

  const triangularWeight = (BigInt(LWMA_WINDOW) * BigInt(LWMA_WINDOW + 1)) / 2n;
  let next = (difficultySum * TARGET_BLOCK_SECONDS * triangularWeight) / weightedSolveTime;
  const previousDifficulty = window[window.length - 1]!.difficulty;
  const upperBound = previousDifficulty * 3n;
  const lowerBound = previousDifficulty / 3n < MINIMUM_DIFFICULTY ? MINIMUM_DIFFICULTY : previousDifficulty / 3n;
  if (next > upperBound) next = upperBound;
  if (next < lowerBound) next = lowerBound;
  return next < MINIMUM_DIFFICULTY ? MINIMUM_DIFFICULTY : next;
}
