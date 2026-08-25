import { FEE_MEMPOOL_THRESHOLD, FEE_TIERS } from './constants';
import { formatEdxAmount, parseEdxAmount } from './amount';

export type FeeTier = keyof typeof FEE_TIERS;

/** Preserve the legacy wallet estimate behavior without making it consensus critical. */
export function feeMultiplier(pendingCount: number, threshold = FEE_MEMPOOL_THRESHOLD): bigint {
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
    throw new RangeError(`invalid pending transaction count: ${pendingCount}`);
  }
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new RangeError(`invalid fee threshold: ${threshold}`);
  }
  return 2n ** BigInt(Math.floor(pendingCount / threshold));
}

export function effectiveFee(baseFee: string, pendingCount: number, threshold = FEE_MEMPOOL_THRESHOLD): string {
  return formatEdxAmount(parseEdxAmount(baseFee) * feeMultiplier(pendingCount, threshold));
}

export function recommendedFeeTier(pendingCount: number, threshold = FEE_MEMPOOL_THRESHOLD): FeeTier {
  const multiplier = feeMultiplier(pendingCount, threshold);
  if (multiplier >= 8n) return 'fast';
  if (multiplier >= 2n) return 'normal';
  return 'slow';
}
