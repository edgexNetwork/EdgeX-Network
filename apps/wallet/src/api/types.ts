export type SyncStatus = "none" | "syncing" | "synced" | "error";

export interface ChainInfoView {
  chain: "edx";
  blocks: number;
  latestHash: string;
  backendHeight: number;
  syncProgress: number;
  localHeight: number;
  syncStatus: SyncStatus;
  syncError: string | null;
  lastBlockTime: number | null;
  phase: 1 | 2 | 3;
  blockReward: string;
  supply: string;
  networkPower: number;
  pendingCount: number;
  connectedNodes: number;
}

export interface FeeTiers {
  slow: string;
  normal: string;
  fast: string;
  multiplier?: string;
  pendingCount?: number;
  recommended?: string;
}

export interface TxInputView {
  txid: string;
  index: number;
  address: string;
  amount: string;
}

export interface TxOutputView {
  address: string;
  amount: string;
  isChange: boolean;
}

export interface TxView {
  txid: string;
  type: "transfer" | "mining";
  category: "send" | "receive";
  amount: string;
  fee: string;
  status: "pending" | "confirmed";
  failed?: boolean;
  lastError?: string | null;
  confirmations: number;
  matureAtHeight: number | null;
  height: number | null;
  time: number;
  from: string | null;
  inputs: TxInputView[];
  outputs: TxOutputView[];
}

export type PeerSource = "config" | "runtime" | "discovered";

export interface PeerView {
  id: number;
  addr: string;
  connected: boolean;
  latencyMs: number | null;
  source: PeerSource;
}

export interface UtxoDTO {
  txid: string;
  index: number;
  address: string;
  amount: string;
  birthHeight: number;
  isCoinbase: boolean;
  spendable: boolean;
}
