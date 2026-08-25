import { MAX_TX_INPUTS, formatEdxAmount, parseEdxAmount, validateAddress } from "@edgex/shared";
import { RPC_CODE, walletError } from "./errors";
import type { PaymentInput } from "./walletCore";
import type { UtxoDTO } from "../api/types";

export interface NormalizedPayment {
  address: string;
  amountPhotons: bigint;
}

export interface PlannedChunk {
  utxos: UtxoDTO[];
  outputs: Array<{ address: string; amountPhotons: bigint }>;
  change: bigint;
}

export const SPLIT_CHUNK_MAX_INPUTS = MAX_TX_INPUTS - 50;

export function normalizePayments(payments: readonly PaymentInput[], from: string): NormalizedPayment[] {
  if (payments.length === 0) throw walletError(RPC_CODE.INVALID_PARAMS, "At least one payment output is required");
  return payments.map((payment) => {
    if (!validateAddress(payment.address)) {
      throw walletError(RPC_CODE.INVALID_ADDRESS_OR_KEY, `Invalid EDX address: ${payment.address}`);
    }
    const amountPhotons = parseEdxAmount(payment.amount);
    if (amountPhotons <= 0n) throw walletError(RPC_CODE.INVALID_PARAMS, "Payment amount must be greater than zero");
    if (payment.address === from) throw walletError(RPC_CODE.INVALID_PARAMS, "Cannot send to yourself");
    return { address: payment.address, amountPhotons };
  });
}

function sortedUtxos(utxos: readonly UtxoDTO[]): UtxoDTO[] {
  return [...utxos].sort((left, right) =>
    left.birthHeight - right.birthHeight ||
    left.txid.localeCompare(right.txid) ||
    left.index - right.index,
  );
}

function sumUtxos(utxos: readonly UtxoDTO[]): bigint {
  return utxos.reduce((total, utxo) => total + parseEdxAmount(utxo.amount), 0n);
}

/**
 * Plan fragmented balances into multiple consensus-valid transactions. Every
 * intermediate transaction sweeps its selected inputs to the payment queue;
 * the final transaction retains change at the sender.
 */
export function planSplitTransfer(
  utxos: readonly UtxoDTO[],
  payments: readonly NormalizedPayment[],
  feePerTransaction: bigint,
  maxInputsPerTransaction = SPLIT_CHUNK_MAX_INPUTS,
): PlannedChunk[] {
  if (!Number.isSafeInteger(maxInputsPerTransaction) || maxInputsPerTransaction < 1) {
    throw walletError(RPC_CODE.INVALID_PARAMS, "Maximum inputs per transaction must be positive");
  }
  if (feePerTransaction <= 0n) throw walletError(RPC_CODE.INVALID_PARAMS, "Fee must be greater than zero");

  const queue = payments.map((payment) => ({ ...payment }));
  const totalPayments = queue.reduce((total, payment) => total + payment.amountPhotons, 0n);
  let remaining = totalPayments;
  const sorted = sortedUtxos(utxos);
  const poolTotal = sumUtxos(sorted);
  if (poolTotal < totalPayments + feePerTransaction) {
    throw insufficientFunds(poolTotal, totalPayments + feePerTx(feePerTransaction, 1));
  }

  const chunks: PlannedChunk[] = [];
  let cursor = 0;
  while (remaining > 0n) {
    const selected: UtxoDTO[] = [];
    let selectedTotal = 0n;
    while (cursor < sorted.length && selected.length < maxInputsPerTransaction) {
      const utxo = sorted[cursor++]!;
      selected.push(utxo);
      selectedTotal += parseEdxAmount(utxo.amount);
      if (selectedTotal - feePerTransaction >= remaining) break;
    }

    const spendable = selectedTotal - feePerTransaction;
    if (spendable <= 0n) {
      throw walletError(
        RPC_CODE.INSUFFICIENT_FUNDS,
        `Selected inputs cannot cover the per-transaction fee (${formatEdxAmount(feePerTransaction)} EDX)`,
      );
    }

    const isFinal = spendable >= remaining;
    const payable = isFinal ? remaining : spendable;
    remaining -= payable;
    const outputs: Array<{ address: string; amountPhotons: bigint }> = [];
    let toFill = payable;
    while (toFill > 0n) {
      const payment = queue[0];
      if (!payment || payment.amountPhotons <= 0n) throw walletError(RPC_CODE.INTERNAL, "split plan payment queue exhausted");
      if (payment.amountPhotons <= toFill) {
        outputs.push({ address: payment.address, amountPhotons: payment.amountPhotons });
        toFill -= payment.amountPhotons;
        queue.shift();
      } else {
        outputs.push({ address: payment.address, amountPhotons: toFill });
        payment.amountPhotons -= toFill;
        toFill = 0n;
      }
    }

    chunks.push({ utxos: selected, outputs, change: isFinal ? spendable - payable : 0n });
    if (remaining > 0n && cursor >= sorted.length) {
      throw insufficientFunds(poolTotal, totalPayments + feePerTx(feePerTransaction, chunks.length));
    }
  }
  return chunks;
}

function feePerTx(fee: bigint, count: number): bigint {
  return fee * BigInt(count);
}

function insufficientFunds(available: bigint, required: bigint): Error {
  return walletError(
    RPC_CODE.INSUFFICIENT_FUNDS,
    `Insufficient balance: available ${formatEdxAmount(available)} EDX, required ${formatEdxAmount(required)} EDX including transaction fees`,
  );
}
