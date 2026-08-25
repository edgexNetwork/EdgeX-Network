import {
  COINBASE_MATURITY,
  GENESIS_ISSUED,
  TOTAL_SUPPLY,
  addressFromPublicKey,
  parseEdxAmount,
  validateAddress,
  validateSignedTransactionShape,
} from '@edgex/shared';
import { rewardForBlock, transactionId } from '@edgex/shared';
import type { SignedTransaction } from '@edgex/shared';
import { coinbaseId } from './block';
import type { Block, UtxoEntry } from './types';

export class UtxoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UtxoValidationError';
  }
}

export interface AppliedBlockResult {
  feeBurnedPhotons: bigint;
  rewardPhotons: bigint;
}

/** An immutable-by-convention UTXO snapshot. Use clone before speculative work. */
export class UtxoState {
  private readonly entries = new Map<string, UtxoEntry>();
  private issuedPhotons = GENESIS_ISSUED;

  constructor(initial?: UtxoState) {
    if (!initial) return;
    for (const entry of initial.entries.values()) this.entries.set(utxoKey(entry.txid, entry.index), { ...entry });
    this.issuedPhotons = initial.issuedPhotons;
  }

  clone(): UtxoState {
    return new UtxoState(this);
  }

  get totalIssued(): bigint {
    return this.issuedPhotons;
  }

  get(key: string): UtxoEntry | undefined {
    return this.entries.get(key);
  }

  balance(address: string): bigint {
    let total = 0n;
    for (const entry of this.entries.values()) {
      if (entry.address === address) total += entry.amountPhotons;
    }
    return total;
  }

  spendable(address: string, currentHeight: number): UtxoEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.address === address)
      .filter((entry) => !entry.isCoinbase || currentHeight >= entry.birthHeight + COINBASE_MATURITY)
      .sort((left, right) => left.birthHeight - right.birthHeight);
  }

  all(address: string): UtxoEntry[] {
    return [...this.entries.values()].filter((entry) => entry.address === address);
  }

  applyBlock(block: Block): AppliedBlockResult {
    const height = block.header.height;
    if (height < 1) throw new UtxoValidationError('genesis has no mutable state transition');

    if (block.coinbase === null) throw new UtxoValidationError('mined block requires a coinbase');
    if (block.coinbase.outputs.length !== 1) throw new UtxoValidationError('coinbase must have exactly one output');
    const coinbaseOutput = block.coinbase.outputs[0]!;
    if (!validateAddress(coinbaseOutput.address)) throw new UtxoValidationError('invalid coinbase address');
    const coinbaseAmount = parseEdxAmount(coinbaseOutput.amount);
    const expectedReward = rewardForBlock(height, this.issuedPhotons);
    if (coinbaseAmount !== expectedReward) {
      throw new UtxoValidationError(`invalid coinbase subsidy: expected ${expectedReward}, got ${coinbaseAmount}`);
    }
    if (this.issuedPhotons + coinbaseAmount > TOTAL_SUPPLY) throw new UtxoValidationError('block exceeds supply cap');
    if (block.header.payoutAddress !== coinbaseOutput.address) {
      throw new UtxoValidationError('header payout does not match coinbase');
    }

    const seenTransactionIds = new Set<string>();
    const validated: Array<{ id: string; consumed: bigint }> = [];
    let feeBurned = 0n;

    for (const [position, transaction] of block.transactions.entries()) {
      const id = transactionIdOrThrow(transaction, position);
      if (seenTransactionIds.has(id)) throw new UtxoValidationError(`duplicate transaction ${id}`);
      seenTransactionIds.add(id);

      const consumed = validateSignedTransactionShape(transaction);
      let inputSum = 0n;
      const senderAddress = addressFromPublicKey(transaction.pubkey);
      for (const input of transaction.inputs) {
        const key = utxoKey(input.txid, input.index);
        const entry = this.entries.get(key);
        if (!entry) throw new UtxoValidationError(`unknown UTXO ${key}`);
        if (entry.address !== senderAddress) throw new UtxoValidationError(`UTXO ${key} is not owned by signer`);
        if (entry.isCoinbase && height < entry.birthHeight + COINBASE_MATURITY) {
          throw new UtxoValidationError(`immature coinbase ${key}`);
        }
        inputSum += entry.amountPhotons;
      }

      const outputSum = transaction.outputs.reduce((total, output) => total + parseEdxAmount(output.amount), 0n);
      if (inputSum !== consumed) throw new UtxoValidationError(`transaction ${id} consumes more than its inputs`);
      if (inputSum - outputSum <= 0n) throw new UtxoValidationError(`transaction ${id} must burn a positive fee`);
      if (inputSum - outputSum !== parseEdxAmount(transaction.fee)) {
        throw new UtxoValidationError(`transaction ${id} fee mismatch`);
      }
      feeBurned += inputSum - outputSum;
      validated.push({ id, consumed });
    }

    // Mutations happen only after every transaction in the candidate is valid.
    for (let position = 0; position < block.transactions.length; position += 1) {
      const transaction = block.transactions[position]!;
      const id = validated[position]!.id;
      for (const input of transaction.inputs) this.entries.delete(utxoKey(input.txid, input.index));
      for (const [index, output] of transaction.outputs.entries()) {
        this.insert({
          txid: id,
          index,
          address: output.address,
          amountPhotons: parseEdxAmount(output.amount),
          isCoinbase: false,
          birthHeight: height,
        });
      }
    }

    const id = coinbaseId(height, block.coinbase);
    this.insert({
      txid: id,
      index: 0,
      address: coinbaseOutput.address,
      amountPhotons: coinbaseAmount,
      isCoinbase: true,
      birthHeight: height,
    });
    this.issuedPhotons += coinbaseAmount;
    return { feeBurnedPhotons: feeBurned, rewardPhotons: coinbaseAmount };
  }

  private insert(entry: UtxoEntry): void {
    this.entries.set(utxoKey(entry.txid, entry.index), entry);
  }
}

function utxoKey(txid: string, index: number): string {
  return `${txid}:${index}`;
}

function transactionIdOrThrow(transaction: SignedTransaction, position: number): string {
  try {
    return transactionId(transaction);
  } catch (error) {
    throw new UtxoValidationError(`invalid transaction at position ${position}: ${(error as Error).message}`);
  }
}
