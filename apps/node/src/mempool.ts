import {
  addressFromPublicKey,
  parseEdxAmount,
  transactionId,
  validateSignedTransactionShape,
} from '@edgex/shared';
import type { SignedTransaction } from '@edgex/shared';
import { COINBASE_MATURITY } from '@edgex/shared';
import { UtxoState } from '@edgex/core';

export interface MempoolEntry {
  id: string;
  transaction: SignedTransaction;
  receivedAtMs: number;
}

export class TransactionMempool {
  private readonly items = new Map<string, MempoolEntry>();
  private readonly maxItems = 10_000;

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(limit = 1_000): MempoolEntry[] {
    return [...this.items.values()].slice(0, limit);
  }

  accept(transaction: SignedTransaction, state: UtxoState, currentHeight: number, nowMs = Date.now()): string {
    const consumed = validateSignedTransactionShape(transaction);
    const id = transactionId(transaction);
    if (this.items.has(id)) return id;

    const sender = addressFromPublicKey(transaction.pubkey);
    let inputSum = 0n;
    for (const input of transaction.inputs) {
      const key = `${input.txid}:${input.index}`;
      const entry = state.get(key);
      if (!entry || entry.address !== sender) throw new Error(`unknown or unowned UTXO ${key}`);
      if (entry.isCoinbase && currentHeight < entry.birthHeight + COINBASE_MATURITY) {
        throw new Error(`coinbase ${key} is not mature`);
      }
      inputSum += entry.amountPhotons;
    }
    const outputSum = transaction.outputs.reduce((total, output) => total + parseEdxAmount(output.amount), 0n);
    if (inputSum !== consumed || inputSum - outputSum !== parseEdxAmount(transaction.fee)) {
      throw new Error('fee does not match inputs and outputs');
    }
    for (const pending of this.items.values()) {
      if (pending.transaction.inputs.some((pendingInput) =>
        transaction.inputs.some((input) => input.txid === pendingInput.txid && input.index === pendingInput.index),
      )) {
        throw new Error('conflicts with a pending transaction');
      }
    }
    if (this.items.size >= this.maxItems) this.items.delete(this.items.keys().next().value!);
    this.items.set(id, { id, transaction, receivedAtMs: nowMs });
    return id;
  }

  /** Called only after consensus has committed a block containing each ID. */
  removeCommitted(ids: readonly string[]): void {
    for (const id of ids) this.items.delete(id);
  }
}
