import type { FeeTiers } from "../api/types";
import { parseEDX } from "../utils/amount";
import { RPC_CODE, walletError } from "./errors";

export type FeeTierName = "slow" | "normal" | "fast";
export const FEE_TIER_NAMES: FeeTierName[] = ["slow", "normal", "fast"];

export function isFeeTierName(v: unknown): v is FeeTierName {
  return v === "slow" || v === "normal" || v === "fast";
}

export function recommendedTier(tiers: FeeTiers): FeeTierName {
  return isFeeTierName(tiers.recommended) ? tiers.recommended : "normal";
}

export interface ResolveFeeOptions {

  explicitFee?: string | null;

  tier?: string | null;
}

export interface ResolvedFee {
  fee: bigint;
  tier: FeeTierName | null;
  source: "explicit" | "tier" | "default";
}





export function resolveFee(tiers: FeeTiers, opts: ResolveFeeOptions = {}): ResolvedFee {
  if (opts.explicitFee !== undefined && opts.explicitFee !== null && opts.explicitFee.trim() !== "") {
    let fee: bigint;
    try {
      fee = parseEDX(opts.explicitFee);
    } catch {
      throw walletError(RPC_CODE.INVALID_PARAMETER, `Invalid fee amount: ${opts.explicitFee}`);
    }
    if (fee <= 0n) throw walletError(RPC_CODE.INVALID_PARAMETER, "Fee must be greater than 0 (zero-fee transactions are rejected)");
    return { fee, tier: null, source: "explicit" };
  }
  if (opts.tier !== undefined && opts.tier !== null && opts.tier.trim() !== "") {
    if (!isFeeTierName(opts.tier)) {
      throw walletError(RPC_CODE.INVALID_PARAMETER, `Invalid fee tier: ${opts.tier} (choose slow/normal/fast)`);
    }
    const fee = parseEDX(tiers[opts.tier]);
    if (fee <= 0n) throw walletError(RPC_CODE.INVALID_PARAMETER, "Fee must be greater than 0 (zero-fee transactions are rejected)");
    return { fee, tier: opts.tier, source: "tier" };
  }
  const tier = recommendedTier(tiers);
  const fee = parseEDX(tiers[tier]);
  if (fee <= 0n) throw walletError(RPC_CODE.INVALID_PARAMETER, "Fee must be greater than 0 (zero-fee transactions are rejected)");
  return { fee, tier, source: "default" };
}