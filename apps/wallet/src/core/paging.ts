import { walletError } from "./errors";
import { RPC_CODE } from "./errors";

/**
 * Shared page-size bounds for every list surface (RPC methods, CLI commands
 * and TUI list views) so count/skip semantics stay identical everywhere.
 */
export const DEFAULT_LIST_COUNT = 100;
export const MAX_LIST_COUNT = 500;
export const DEFAULT_HISTORY_COUNT = 20;

function invalidPageParam(message: string): never {
  throw walletError(RPC_CODE.INVALID_PARAMS, message);
}

/**
 * Parse a `count` argument: an integer in [1, MAX_LIST_COUNT]. Missing values
 * (undefined/null/empty) fall back to `fallback`; anything else is an
 * invalid-parameter error (-32602) so callers can rely on the returned number.
 */
export function parseCount(raw: unknown, fallback = DEFAULT_LIST_COUNT): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") invalidPageParam("Invalid page count: expected an integer in [1, 500]");
  if (typeof raw === "string") {
    if (raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) invalidPageParam("Invalid page count: expected an integer in [1, 500]");
    return parseCount(parsed, fallback);
  }
  if (typeof raw !== "number") invalidPageParam("Invalid page count: expected an integer in [1, 500]");
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIST_COUNT) {
    invalidPageParam("Invalid page count: expected an integer in [1, 500]");
  }
  return raw;
}

/**
 * Parse a `skip` argument: a non-negative integer. Missing values default to 0.
 */
export function parseSkip(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "boolean") invalidPageParam("Invalid page skip: expected a non-negative integer");
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 0) {
    invalidPageParam("Invalid page skip: expected a non-negative integer");
  }
  return value;
}

/** Parse a trailing `[count, skip]` pair (either may be omitted). */
export function parsePageParams(raw: unknown[]): { count: number; skip: number } {
  return { count: parseCount(raw[0]), skip: parseSkip(raw[1]) };
}
