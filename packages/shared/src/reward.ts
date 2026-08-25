import {
  EDX_UNIT,
  GENESIS_ISSUED,
  PHASE_1_MAX_HEIGHT,
  PHASE_1_REWARD,
  PHASE_2_DIVISOR,
  PHASE_2_MAX_HEIGHT,
  PHASE_3_REWARD,
  TOTAL_SUPPLY,
} from './constants';

export type RewardPhase = 1 | 2 | 3;

export function phaseForHeight(height: number): RewardPhase {
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new RangeError(`invalid mined block height: ${height}`);
  }
  if (height <= PHASE_1_MAX_HEIGHT) return 1;
  if (height <= PHASE_2_MAX_HEIGHT) return 2;
  return 3;
}

/**
 * Return the subsidy for a mined block before its fee is considered.
 * Genesis has no coinbase; phase two starts after exactly 207,360,000 EDX.
 */
export function rewardForBlock(height: number, issuedPhotons: bigint = GENESIS_ISSUED): bigint {
  if (issuedPhotons < 0n || issuedPhotons > TOTAL_SUPPLY) {
    throw new RangeError(`invalid issued amount: ${issuedPhotons}`);
  }
  const phase = phaseForHeight(height);
  if (phase === 1) return PHASE_1_REWARD;
  if (phase === 3) return PHASE_3_REWARD;

  const remaining = TOTAL_SUPPLY - issuedPhotons;
  // Preserve the legacy whole-EDX rounding boundary before converting to Photons.
  const rewardEdx = remaining / (EDX_UNIT * PHASE_2_DIVISOR);
  return (rewardEdx < 1n ? 1n : rewardEdx) * EDX_UNIT;
}

export function totalIssuedAfterBlock(height: number, issuedBefore: bigint = GENESIS_ISSUED): bigint {
  return issuedBefore + rewardForBlock(height, issuedBefore);
}

export function phaseRewardAtBoundary(): { height: number; reward: bigint } {
  const issued = BigInt(PHASE_1_MAX_HEIGHT) * PHASE_1_REWARD;
  return { height: PHASE_1_MAX_HEIGHT + 1, reward: rewardForBlock(PHASE_1_MAX_HEIGHT + 1, issued) };
}

// Keep a runtime guard adjacent to the constants that define the supply cap.
export function assertNoPremine(issuedAtGenesis: bigint): void {
  if (issuedAtGenesis !== GENESIS_ISSUED) {
    throw new Error('genesis must contain zero premine');
  }
}

export const EDX_UNIT_EXPORT = EDX_UNIT;
