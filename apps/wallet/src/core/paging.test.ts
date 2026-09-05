import { describe, expect, test } from "bun:test";
import { RPC_CODE } from "./errors";
import {
  DEFAULT_HISTORY_COUNT,
  DEFAULT_LIST_COUNT,
  MAX_LIST_COUNT,
  parseCount,
  parsePageParams,
  parseSkip,
} from "./paging";

function errorCode(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: number }).code ?? null;
  }
}

describe("paging parameter parsing", () => {
  test("parseCount defaults and accepts the documented bounds", () => {
    expect(parseCount(undefined)).toBe(DEFAULT_LIST_COUNT);
    expect(parseCount(null)).toBe(DEFAULT_LIST_COUNT);
    expect(parseCount(undefined, DEFAULT_HISTORY_COUNT)).toBe(DEFAULT_HISTORY_COUNT);
    expect(parseCount(1)).toBe(1);
    expect(parseCount(MAX_LIST_COUNT)).toBe(MAX_LIST_COUNT);
    expect(parseCount("25")).toBe(25);
    expect(parseCount("", 7)).toBe(7);
  });

  test("parseCount rejects out-of-range and malformed values with -32602", () => {
    expect(errorCode(() => parseCount(0))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount(-3))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount(MAX_LIST_COUNT + 1))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount(1.5))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount("abc"))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount(true))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseCount({}))).toBe(RPC_CODE.INVALID_PARAMS);
  });

  test("parseSkip defaults to zero and accepts non-negative integers", () => {
    expect(parseSkip(undefined)).toBe(0);
    expect(parseSkip(null)).toBe(0);
    expect(parseSkip(0)).toBe(0);
    expect(parseSkip(42)).toBe(42);
    expect(parseSkip("7")).toBe(7);
  });

  test("parseSkip rejects negatives, fractions and non-numbers with -32602", () => {
    expect(errorCode(() => parseSkip(-1))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseSkip(2.5))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseSkip("x"))).toBe(RPC_CODE.INVALID_PARAMS);
    expect(errorCode(() => parseSkip(false))).toBe(RPC_CODE.INVALID_PARAMS);
  });

  test("parsePageParams combines both values", () => {
    expect(parsePageParams([undefined, undefined])).toEqual({ count: DEFAULT_LIST_COUNT, skip: 0 });
    expect(parsePageParams([10, 5])).toEqual({ count: 10, skip: 5 });
  });
});
