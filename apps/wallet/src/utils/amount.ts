import { formatEdxAmount, parseEdxAmount } from "@edgex/shared";

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

export function parseEDX(input: string | number): bigint {
  try {
    return parseEdxAmount(typeof input === "number" ? input.toString() : input.trim());
  } catch (error) {
    throw new AmountError((error as Error).message);
  }
}

/** Render Photons in the legacy bitcoind-style fixed eight-decimal format. */
export function formatEDX(value: bigint): string {
  const negative = value < 0n;
  const absolute = (negative ? -value : value).toString().padStart(9, "0");
  const formatted = `${absolute.slice(0, -8)}.${absolute.slice(-8)}`;
  return negative ? `-${formatted}` : formatted;
}

export function formatEDXDisplay(value: bigint): string {
  return formatEdxAmount(value);
}

export function trimEDX(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const trimmed = body.includes(".") ? body.replace(/0+$/, "").replace(/\.$/, "") : body;
  return negative ? `-${trimmed || "0"}` : trimmed || "0";
}

export const ZERO = 0n;
