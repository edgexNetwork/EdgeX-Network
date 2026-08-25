import type { SignedTransaction } from '@edgex/shared';

export interface BlockHeader {
  version: number;
  height: number;
  previousHash: string;
  timestampSeconds: number;
  difficulty: bigint;
  merkleRoot: string;
  powSeed: string;
  payoutAddress: string;
}

export interface CoinbaseOutput {
  address: string;
  amount: string;
}

export interface CoinbaseTransaction {
  outputs: CoinbaseOutput[];
}

export interface Block {
  header: BlockHeader;
  hash: string;
  nonce: number;
  coinbase: CoinbaseTransaction | null;
  transactions: SignedTransaction[];
}

export interface StoredBlock extends Block {
  receivedAtMs?: number;
}

export interface UtxoEntry {
  txid: string;
  index: number;
  address: string;
  amountPhotons: bigint;
  isCoinbase: boolean;
  birthHeight: number;
}

export interface ChainWorkSummary {
  height: number;
  timestampSeconds: number;
  difficulty: bigint;
}
