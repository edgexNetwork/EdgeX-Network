import { describe, expect, test } from "bun:test";
import { addressFromPublicKey, formatEdxAmount, generateKeyPair } from "@edgex/shared";
import type { UtxoDTO } from "../src/api/types";
import {
  SPLIT_CHUNK_MAX_INPUTS,
  normalizePayments,
  orderUtxosByAddress,
  planAddressChunks,
  planSplitTransfer,
} from "../src/core/transactionPlanner";

function utxo(index: number, amountPhotons: bigint, owner = "EDXSENDER"): UtxoDTO {
  return {
    txid: index.toString(16).padStart(64, "0"),
    index: 0,
    address: owner,
    amount: formatEdxAmount(amountPhotons),
    birthHeight: index,
    isCoinbase: false,
    spendable: true,
  };
}

function address(): string {
  return addressFromPublicKey(generateKeyPair().publicKeyHex);
}

describe("fragmented transaction planner", () => {
  test("splits more than the maximum inputs into linked transactions", () => {
    const sender = address();
    const recipient = address();
    const count = SPLIT_CHUNK_MAX_INPUTS + 51;
    const dust = 1_000_000n;
    const inputs = Array.from({ length: count }, (_, index) => utxo(index, dust));
    const fee = 1n;
    const planned = planSplitTransfer(inputs, normalizePayments([{ address: recipient, amount: "10.00000000" }], sender), fee);

    expect(planned.length).toBe(2);
    expect(planned[0]!.utxos.length).toBe(SPLIT_CHUNK_MAX_INPUTS);
    expect(planned[1]!.utxos.length).toBe(count - SPLIT_CHUNK_MAX_INPUTS);
    expect(planned[0]!.change).toBe(0n);
    expect(planned[1]!.change).toBeGreaterThan(0n);

    const allInputs = planned.flatMap((chunk) => chunk.utxos);
    expect(new Set(allInputs.map((input) => input.txid)).size).toBe(count);
    const paid = planned.flatMap((chunk) => chunk.outputs).reduce((total, output) => total + output.amountPhotons, 0n);
    const fees = BigInt(planned.length) * fee;
    const change = planned.reduce((total, chunk) => total + chunk.change, 0n);
    expect(paid + fees + change).toBe(BigInt(count) * dust);
  });

  test("rejects self-payment and balances that cannot cover every split fee", () => {
    const sender = address();
    expect(() => normalizePayments([{ address: sender, amount: "1" }], sender)).toThrow(/yourself/);
    const recipient = address();
    expect(() => planSplitTransfer([utxo(0, 10n)], normalizePayments([{ address: recipient, amount: "0.00000001" }], sender), 100n))
      .toThrow(/Insufficient balance/);
  });
});

describe("multi-address transaction planner", () => {
  test("orderUtxosByAddress groups by owner, FIFO within a group, largest group first", () => {
    const a1 = address();
    const a2 = address();
    const groups = orderUtxosByAddress([
      utxo(1, 500n, a1),
      utxo(0, 300n, a1),
      utxo(2, 900n, a2),
    ]);
    // a2 total (900) sorts before a1 (800); within a1 oldest birthHeight first.
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((u) => u.address)).toEqual([a2]);
    expect(groups[1]!.map((u) => u.address)).toEqual([a1, a1]);
    expect(groups[1]![0]!.birthHeight).toBe(0);
    expect(groups[1]![1]!.birthHeight).toBe(1);
  });

  test("planAddressChunks never mixes addresses in one transaction and keeps change at the funding address", () => {
    const a1 = address();
    const a2 = address();
    const recipient = address();
    const fee = 1_000_000n; // 0.01 EDX
    // a1 holds 90, a2 holds 80: a payment of 100 crosses the group boundary.
    const utxos = [
      utxo(1, 90n * 100_000_000n, a1),
      utxo(2, 80n * 100_000_000n, a2),
    ];
    const groups = orderUtxosByAddress(utxos);
    const chunks = planAddressChunks(groups, normalizePayments([{ address: recipient, amount: "100.00000000" }], a1), fee);
    expect(chunks.length).toBe(2);
    // First chunk is funded solely by a1 (which cannot cover 100 + fee alone)
    expect(chunks[0]!.from).toBe(a1);
    expect(chunks[0]!.utxos.every((u) => u.address === a1)).toBe(true);
    expect(chunks[0]!.change).toBe(0n);
    // Second chunk finishes the payment from a2 and keeps the change at a2.
    expect(chunks[1]!.from).toBe(a2);
    expect(chunks[1]!.utxos.every((u) => u.address === a2)).toBe(true);
    expect(chunks[1]!.change).toBeGreaterThan(0n);
    const paid = chunks.flatMap((chunk) => chunk.outputs).reduce((total, output) => total + output.amountPhotons, 0n);
    const totalFees = BigInt(chunks.length) * fee;
    const change = chunks.reduce((total, chunk) => total + chunk.change, 0n);
    expect(paid).toBe(100n * 100_000_000n);
    expect(paid + totalFees + change).toBe(170n * 100_000_000n);
  });

  test("planAddressChunks settles a single-address payment in one chunk", () => {
    const a1 = address();
    const recipient = address();
    const fee = 1_000_000n;
    const chunks = planAddressChunks(
      orderUtxosByAddress([utxo(1, 120n * 100_000_000n, a1)]),
      normalizePayments([{ address: recipient, amount: "100.00000000" }], a1),
      fee,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.from).toBe(a1);
    // 120 in - 100 out - 0.01 fee = 19.99 change
    expect(chunks[0]!.change).toBe(1_999_000_000n);
  });
});
