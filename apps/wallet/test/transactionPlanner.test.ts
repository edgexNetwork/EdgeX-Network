import { describe, expect, test } from "bun:test";
import { addressFromPublicKey, formatEdxAmount, generateKeyPair } from "@edgex/shared";
import type { UtxoDTO } from "../src/api/types";
import { SPLIT_CHUNK_MAX_INPUTS, normalizePayments, planSplitTransfer } from "../src/core/transactionPlanner";

function utxo(index: number, amountPhotons: bigint): UtxoDTO {
  return {
    txid: index.toString(16).padStart(64, "0"),
    index: 0,
    address: "EDXSENDER",
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
