import type { ChainInfoView, SyncStatus } from "../api/types";

export interface ChainUpdate {
  height?: number;
  latestHash?: string;
  phase?: 1 | 2 | 3;
  currentReward?: string;
  totalIssued?: string;
  networkPower?: number;
  pendingCount?: number;
  connectedNodes: number;
}






export class ChainState {
  height = 0;
  hash = "";
  prevHash = "";
  phase: 1 | 2 | 3 = 1;
  blockReward = "";
  supply = "";
  networkPower = 0;
  pendingCount = 0;
  connectedNodes = 0;
  lastUpdated = 0;
  hasData = false;

  localHeight = 0;

  syncStatus: SyncStatus = "none";

  syncError: string | null = null;

  lastBlockTime: number | null = null;

  update(dto: ChainUpdate): void {
    if (typeof dto.height === "number") this.height = dto.height;
    if (typeof dto.latestHash === "string" && dto.latestHash) this.hash = dto.latestHash;
    if (typeof dto.phase === "number" && (dto.phase === 1 || dto.phase === 2 || dto.phase === 3)) {
      this.phase = dto.phase;
    }
    if (typeof dto.currentReward === "string" && dto.currentReward) this.blockReward = dto.currentReward;
    if (typeof dto.totalIssued === "string" && dto.totalIssued) this.supply = dto.totalIssued;
    if (typeof dto.networkPower === "number") this.networkPower = dto.networkPower;
    if (typeof dto.pendingCount === "number") this.pendingCount = dto.pendingCount;
    this.connectedNodes = dto.connectedNodes;
    this.lastUpdated = Date.now();
    this.hasData = true;
  }


  setSync(s: {
    localHeight?: number;
    syncStatus?: SyncStatus;
    syncError?: string | null;
    lastBlockTime?: number | null;
  }): void {
    if (s.localHeight !== undefined) this.localHeight = s.localHeight;
    if (s.syncStatus !== undefined) this.syncStatus = s.syncStatus;
    if (s.syncError !== undefined) this.syncError = s.syncError;
    if (s.lastBlockTime !== undefined) this.lastBlockTime = s.lastBlockTime;
  }

  get backendHeight(): number {
    return this.height;
  }


  isSynced(): boolean {
    return this.syncStatus === "synced";
  }


  get syncProgress(): number {
    if (this.syncStatus === "error") return 0;
    if (this.backendHeight <= 0) return this.localHeight > 0 ? 1 : 0;
    return Math.min(1, this.localHeight / this.backendHeight);
  }

  toView(): ChainInfoView {
    const phase = this.hasData ? this.phase : 1;
    return {
      chain: "edx",
      blocks: this.height,
      latestHash: this.hash,
      backendHeight: this.backendHeight,
      syncProgress: this.syncProgress,
      localHeight: this.localHeight,
      syncStatus: this.syncStatus,
      syncError: this.syncError,
      lastBlockTime: this.lastBlockTime,
      phase,
      blockReward: this.blockReward,
      supply: this.supply,
      networkPower: this.networkPower,
      pendingCount: this.pendingCount,
      connectedNodes: this.connectedNodes,
    };
  }
}
