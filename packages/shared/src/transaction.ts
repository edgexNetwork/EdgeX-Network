import { MAX_TX_INPUTS, MAX_TX_OUTPUTS } from './constants';
import { InvalidAmountError, formatEdxAmount, parseEdxAmount } from './amount';
import {
  signedTransactionId,
  transactionMessage,
  validateAddress,
  verifySignature,
} from './crypto/keys';

export interface TransactionInput {
  txid: string;
  index: number;
}

export interface TransactionOutput {
  address: string;
  amount: string;
}

export interface SignedTransaction {
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  fee: string;
  pubkey: string;
  signature: string;
}

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionValidationError';
  }
}

function requireHex(value: string, length: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new TransactionValidationError(`${label} must be ${length}-character lowercase hex`);
  }
}

/** Validate intrinsic fields; UTXO existence and ownership are checked by consensus state. */
export function validateSignedTransactionShape(transaction: SignedTransaction): bigint {
  if (!Array.isArray(transaction.inputs) || transaction.inputs.length === 0 || transaction.inputs.length > MAX_TX_INPUTS) {
    throw new TransactionValidationError(`transaction must contain 1-${MAX_TX_INPUTS} inputs`);
  }
  if (!Array.isArray(transaction.outputs) || transaction.outputs.length === 0 || transaction.outputs.length > MAX_TX_OUTPUTS) {
    throw new TransactionValidationError(`transaction must contain 1-${MAX_TX_OUTPUTS} outputs`);
  }

  const seenInputs = new Set<string>();
  for (const [index, input] of transaction.inputs.entries()) {
    if (!Number.isSafeInteger(input.index) || input.index < 0) {
      throw new TransactionValidationError(`invalid input index at position ${index}`);
    }
    requireHex(input.txid, 64, `txid at input ${index}`);
    const key = `${input.txid}:${input.index}`;
    if (seenInputs.has(key)) throw new TransactionValidationError('duplicate input reference');
    seenInputs.add(key);
  }

  let outputTotal = 0n;
  for (const [index, output] of transaction.outputs.entries()) {
    if (!validateAddress(output.address)) {
      throw new TransactionValidationError(`invalid output address at position ${index}`);
    }
    try {
      const amount = parseEdxAmount(output.amount);
      if (amount <= 0n) throw new TransactionValidationError(`non-positive output at position ${index}`);
      outputTotal += amount;
    } catch (error) {
      if (error instanceof TransactionValidationError) throw error;
      throw new TransactionValidationError(`invalid output amount at position ${index}`);
    }
  }

  let fee: bigint;
  try {
    fee = parseEdxAmount(transaction.fee);
  } catch (error) {
    if (error instanceof InvalidAmountError) throw new TransactionValidationError('invalid fee');
    throw error;
  }
  if (fee <= 0n) throw new TransactionValidationError('fee must be greater than zero');

  requireHex(transaction.pubkey, 66, 'public key');
  requireHex(transaction.signature, 128, 'signature');
  if (!['02', '03'].includes(transaction.pubkey.slice(0, 2))) {
    throw new TransactionValidationError('public key must be compressed');
  }
  if (!verifySignature(transaction.pubkey, transactionMessage(transaction), transaction.signature)) {
    throw new TransactionValidationError('invalid transaction signature');
  }

  return outputTotal + fee;
}

export function transactionId(transaction: SignedTransaction): string {
  validateSignedTransactionShape(transaction);
  return signedTransactionId(transaction);
}

export function normalizedTransaction(transaction: SignedTransaction): SignedTransaction {
  return {
    inputs: [...transaction.inputs],
    outputs: transaction.outputs.map((output) => ({ ...output })),
    fee: formatEdxAmount(parseEdxAmount(transaction.fee)),
    pubkey: transaction.pubkey,
    signature: transaction.signature,
  };
}
