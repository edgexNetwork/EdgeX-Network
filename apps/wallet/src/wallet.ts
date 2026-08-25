import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  DERIVATION_PATH,
  addressFromPublicKey,
  formatEdxAmount,
  parseEdxAmount,
  signTransaction,
} from '@edgex/shared';
import type { SignedTransaction } from '@edgex/shared';

export interface WalletKey {
  mnemonic: string;
  privateKeyHex: string;
  publicKeyHex: string;
  address: string;
}

export interface UtxoView {
  txid: string;
  index: number;
  amount: string;
  birthHeight?: number | undefined;
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export function normalizeMnemonic(value: string): string {
  return value.trim().split(/\s+/).join(' ').toLowerCase();
}

export function createWalletKey(): WalletKey {
  return walletFromMnemonic(generateMnemonic(wordlist, 256));
}

export function walletFromMnemonic(mnemonicValue: string): WalletKey {
  const mnemonic = normalizeMnemonic(mnemonicValue);
  if (!validateMnemonic(mnemonic, wordlist)) throw new WalletError('invalid BIP39 mnemonic');
  const derived = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DERIVATION_PATH);
  const privateKey = derived.privateKey;
  const publicKey = derived.publicKey;
  if (!privateKey || !publicKey) throw new WalletError('unable to derive wallet key');
  return {
    mnemonic,
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
    address: addressFromPublicKey(bytesToHex(publicKey)),
  };
}

export interface PlannedTransaction {
  unsigned: {
    inputs: Array<{ txid: string; index: number }>;
    outputs: Array<{ address: string; amount: string }>;
    fee: string;
  };
  change: bigint;
}


export function planTransaction(
  utxos: readonly UtxoView[],
  recipient: string,
  changeAddress: string,
  amount: string,
  fee: string,
): PlannedTransaction {
  const targetAmount = parseEdxAmount(amount);
  const targetFee = parseEdxAmount(fee);
  if (targetAmount <= 0n || targetFee <= 0n) throw new WalletError('amount and fee must be positive');

  let selectedTotal = 0n;
  const selected: UtxoView[] = [];
  for (const utxo of [...utxos].sort((left, right) => (left.birthHeight ?? 0) - (right.birthHeight ?? 0))) {
    selected.push(utxo);
    selectedTotal += parseEdxAmount(utxo.amount);
    if (selectedTotal >= targetAmount + targetFee) break;
  }
  if (selectedTotal < targetAmount + targetFee) throw new WalletError('insufficient spendable balance');

  const change = selectedTotal - targetAmount - targetFee;
  const outputs = [{ address: recipient, amount: formatEdxAmount(targetAmount) }];
  if (change > 0n) outputs.push({ address: changeAddress, amount: formatEdxAmount(change) });
  return {
    unsigned: {
      inputs: selected.map((utxo) => ({ txid: utxo.txid, index: utxo.index })),
      outputs,
      fee: formatEdxAmount(targetFee),
    },
    change,
  };
}

export function signPlannedTransaction(planned: PlannedTransaction, key: WalletKey): SignedTransaction {
  return signTransaction(planned.unsigned, key.privateKeyHex);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
