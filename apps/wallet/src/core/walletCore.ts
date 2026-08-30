import { COIN_SYMBOL, FEE_TIERS, formatEdxAmount, parseEdxAmount, phaseForHeight, rewardForBlock, validateAddress } from "@edgex/shared";
import { signTransaction } from "@edgex/shared";
import type { SignedTransaction } from "@edgex/shared";
import type { ChainInfoView, FeeTiers, PeerView, TxView, UtxoDTO } from "../api/types";
import { EventBus } from "./eventBus";
import { ChainState } from "./chainState";
import { ConnectionManager } from "./connection";
import { WalletError, walletError, RPC_CODE } from "./errors";
import { resolveFee } from "./fee";
import { loadWalletKey, verifyVaultPassword } from "../keys/walletKeyClean";
import { readVaultFile } from "../keys/vaultLegacy";
import type { Logger } from "../utils/log";
import type { WalletConfig } from "../config/config";
import type { WalletKey } from "../keys/walletKeyClean";
import path from "node:path";
import { CHAIN_DB_FILE_NAME } from "../config/config";
import { ChainDataError, ChainStore, deriveChainDbKey } from "./walletDatabase";
import { normalizePayments, planSplitTransfer } from "./transactionPlanner";

const POLL_INTERVAL_MS = 15_000;
export interface PaymentInput {
  address: string;
  amount: string;
}

export interface SendOptions {
  explicitFee?: string | null;
  tier?: string | null;
}

export interface MiningInfo {
  difficulty: string;
  networkHashps: number;
  hashrate: number;
}

export class WalletCore {
  readonly bus = new EventBus();
  readonly chain = new ChainState();
  readonly database: ChainStore;
  readonly conn: ConnectionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fees: FeeTiers | null = null;
  private feeFetchedAt = 0;
  private transactions: TxView[] = [];
  private balanceValue: bigint | null = null;

  constructor(
    readonly config: WalletConfig,
    readonly key: WalletKey,
    private readonly log: Logger,
  ) {
    const baseUrl = config.nodeUrl ?? config.addnodes[0] ?? "http://127.0.0.1:28332";
    this.database = new ChainStore(
      path.join(config.datadir, CHAIN_DB_FILE_NAME),
      deriveChainDbKey(key.privateKey),
      key.address,
    );
    this.conn = new ConnectionManager({
      nodeUrl: baseUrl,
      configuredNodes: config.addnodes,
      nodeId: key.address,
      peerStoreFile: path.join(config.datadir, "peers.json"),
      log,
      onBlock: (block) => this.bus.emit("block:push", block),
      onTransaction: () => {
        void this.refreshTransactions(20).catch(() => undefined);
      },
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.conn.start();
    const opened = this.database.open();
    if (!opened.ok) {
      const reason = opened.error ?? "unknown wallet database error";
      this.log.error(`Local wallet database failed to open: ${reason}`);
      this.chain.setSync({ localHeight: 0, syncStatus: "error", syncError: reason, lastBlockTime: null });
    } else {
      const tip = this.database.localTip();
      this.chain.setSync({
        localHeight: Math.max(0, tip.height),
        syncStatus: "syncing",
        syncError: null,
        lastBlockTime: tip.ts > 0 ? tip.ts : null,
      });
      void this.refreshAll().catch((error) => this.log.warn(`Wallet refresh failed: ${(error as Error).message}`));
    }
    this.timer = setInterval(() => void this.refreshAll(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.conn.stop();
    try {
      this.database.save();
      this.database.close();
    } catch (error) {
      this.log.warn(`Wallet database close failed: ${(error as Error).message}`);
    }
    this.bus.emit("shutdown", undefined);
  }

  requestStop(): void {
    void this.stop();
  }

  getAddress(): string {
    return this.key.address;
  }

  requirePassword(): boolean {
    try {
      readVaultFile(this.config.datadir);
      return true;
    } catch {
      return false;
    }
  }

  getMnemonic(password: string): string {
    const key = loadWalletKey(this.config.datadir, password);
    if (key.address !== this.key.address) throw walletError(RPC_CODE.GENERIC, "Wallet password belongs to another wallet");
    return key.mnemonic;
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled([this.refreshChain(), this.refreshBalance(), this.refreshTransactions(20)]);
  }

  async refreshChain(): Promise<ChainInfoView> {
    const info = await this.conn.request<Record<string, unknown>>("GET", "/chain/info");
    const height = Number(info.height ?? 0);
    const totalIssuedPhotons = parseEdxAmount(String(info.totalIssued ?? "0"));
    const reward = rewardForBlock(Math.max(1, height + 1), totalIssuedPhotons);
    this.chain.update({
      height,
      latestHash: String(info.bestHash ?? ""),
      phase: phaseForHeight(Math.max(1, height + 1)),
      currentReward: formatEdxAmount(reward),
      totalIssued: String(info.totalIssued ?? "0"),
      networkPower: Number(info.networkPower ?? info.networkHashps ?? 0),
      pendingCount: Number(info.mempoolSize ?? 0),
      connectedNodes: this.conn.connectedCount,
    });
    const localTip = this.database.localTip();
    this.chain.setSync({
      localHeight: Math.max(0, localTip.height),
      syncStatus: localTip.height >= height ? "synced" : this.conn.connectedCount > 0 ? "syncing" : "none",
      syncError: null,
      lastBlockTime: localTip.ts > 0 ? localTip.ts : null,
    });
    await this.synchronizeLocalDatabase(height, String(info.genesisHash ?? ""));
    const view = this.chain.toView();
    this.bus.emit("chain:update", view);
    return view;
  }

  async getChainInfo(): Promise<ChainInfoView> {
    return this.refreshChain();
  }

  async refreshBalance(): Promise<bigint | null> {
    const utxos = await this.conn
      .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(this.key.address)}`)
      .then((result) => result.items);
    let available = 0n;
    let immature = 0n;
    const maturity = 6;
    for (const utxo of utxos) {
      const amount = parseEdxAmount(utxo.amount);
      if (utxo.spendable) available += amount;
      else if (utxo.isCoinbase && this.chain.height < utxo.birthHeight + maturity) immature += amount;
    }
    this.balanceValue = available;
    this.bus.emit("balance:update", formatEdxAmount(available));
    return available;
  }

  async getAvailableBalance(): Promise<bigint | null> {
    await this.refreshBalance().catch(() => undefined);
    return this.balanceValue;
  }

  async getBalanceDetail(): Promise<{ chain: string; reserved: string; available: string; immature: string } | null> {
    try {
      const utxos = await this.conn
        .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(this.key.address)}`)
        .then((result) => result.items);
      let available = 0n;
      let total = 0n;
      let immature = 0n;
      for (const utxo of utxos) {
        const value = parseEdxAmount(utxo.amount);
        total += value;
        if (utxo.spendable) available += value;
        else if (utxo.isCoinbase && this.chain.height < utxo.birthHeight + 6) immature += value;
      }
      return {
        chain: formatEdxAmount(total),
        reserved: "0",
        available: formatEdxAmount(available),
        immature: formatEdxAmount(immature),
      };
    } catch {
      return null;
    }
  }

  async getBalance(): Promise<string> {
    const balance = await this.getAvailableBalance();
    return formatEdxAmount(balance ?? 0n);
  }

  async getFees(force = false): Promise<FeeTiers> {
    if (!force && this.fees && Date.now() - this.feeFetchedAt < 30_000) return this.fees;
    const info = await this.conn.request<Record<string, unknown>>("GET", "/chain/info").catch(() => ({ mempoolSize: 0 }));
    const pendingCount = Number(info.mempoolSize ?? 0);
    this.fees = {
      ...FEE_TIERS,
      multiplier: pendingCount >= 100 ? "2" : "1",
      pendingCount,
      recommended: pendingCount >= 100 ? "fast" : "normal",
    };
    this.feeFetchedAt = Date.now();
    this.bus.emit("fees:update", this.fees);
    return this.fees;
  }

  async send(payments: PaymentInput[], options: SendOptions = {}, password?: string): Promise<string> {
    if (!this.chain.isSynced()) throw walletError(RPC_CODE.GENERIC, "Local chain is not synced yet");
    const normalizedPayments = normalizePayments(payments, this.key.address);
    if (this.requirePassword()) {
      if (!password) throw walletError(RPC_CODE.GENERIC, "Wallet locked: password required");
      const unlocked = loadWalletKey(this.config.datadir, password);
      if (unlocked.address !== this.key.address) throw walletError(RPC_CODE.GENERIC, "Wrong wallet password");
    }

    const fee = resolveFee(await this.getFees(), { explicitFee: options.explicitFee, tier: options.tier });
    const utxos = (await this.conn
      .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(this.key.address)}`)
      .then((result) => result.items)).filter((utxo) => utxo.spendable);

    const chunks = planSplitTransfer(utxos, normalizedPayments, fee.fee);
    let firstTxid: string | null = null;
    for (const chunk of chunks) {
      const outputs = chunk.outputs.map((output) => ({
        address: output.address,
        amount: formatEdxAmount(output.amountPhotons),
      }));
      if (chunk.change > 0n) {
        outputs.push({ address: this.key.address, amount: formatEdxAmount(chunk.change) });
      }
      const signed: SignedTransaction = signTransaction(
        {
          inputs: chunk.utxos.map((utxo) => ({ txid: utxo.txid, index: utxo.index })),
          outputs,
          fee: formatEdxAmount(fee.fee),
        },
        Buffer.from(this.key.privateKey).toString("hex"),
      );
      const txid = await this.conn
        .request<{ txid: string }>("POST", "/transactions", signed)
        .then((result) => result.txid);
      firstTxid ??= txid;
    }
    await Promise.allSettled([this.refreshBalance(), this.refreshTransactions(20)]);
    return firstTxid!;
  }

  /**
   * 构建并签名一笔游戏小费交易（自动签名免确认路径，供本地游戏网关使用）：
   * 与 send() 同一套选币/签名机制（FIFO 选输入 + 按体积计费 + 找零），但只返回已签名交易，
   * 直接广播上链、无交互确认——安全边界靠游戏网关钳制单笔上限（gamefee）与每日累计上限（gamefeeperday）。
   * 密码校验：显式 password（TUI 解锁后内存持有 / daemon 的 EDX_WALLET_PASSWORD），缺失时抛错。
   */
  async buildGameFeeTx(payments: PaymentInput[], password?: string): Promise<SignedTransaction> {
    if (!this.chain.isSynced()) {
      throw walletError(
        RPC_CODE.GENERIC,
        "Blockchain sync in progress; game uploads are disabled until fully synced",
      );
    }
    if (this.requirePassword()) {
      if (!password) {
        throw walletError(
          RPC_CODE.GENERIC,
          "Wallet locked: game uploads need the wallet password (provide password or unlock first)",
        );
      }
      const unlocked = loadWalletKey(this.config.datadir, password);
      if (unlocked.address !== this.key.address) throw walletError(RPC_CODE.GENERIC, "Wrong wallet password; game upload rejected");
    }

    const fee = resolveFee(await this.getFees(), {});
    const normalizedPayments = normalizePayments(payments, this.key.address);
    const utxos = (await this.conn
      .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(this.key.address)}`)
      .then((result) => result.items)).filter((utxo) => utxo.spendable);

    // 小费金额极小，单笔转账即可覆盖（planSplitTransfer 保证 payments 非空时至少一个 chunk）
    const chunk = planSplitTransfer(utxos, normalizedPayments, fee.fee)[0]!;
    const outputs = chunk.outputs.map((output) => ({
      address: output.address,
      amount: formatEdxAmount(output.amountPhotons),
    }));
    if (chunk.change > 0n) {
      outputs.push({ address: this.key.address, amount: formatEdxAmount(chunk.change) });
    }
    return signTransaction(
      {
        inputs: chunk.utxos.map((utxo) => ({ txid: utxo.txid, index: utxo.index })),
        outputs,
        fee: formatEdxAmount(fee.fee),
      },
      Buffer.from(this.key.privateKey).toString("hex"),
    );
  }

  async listTransactions(limit = 20): Promise<TxView[]> {
    return this.conn.request<TxView[]>("GET", `/wallet/history?address=${encodeURIComponent(this.key.address)}&limit=${limit}`);
  }

  async refreshTransactions(limit = 20): Promise<TxView[]> {
    this.transactions = await this.conn.request<TxView[]>("GET", `/wallet/history?address=${encodeURIComponent(this.key.address)}&limit=${limit}`);
    this.bus.emit("tx:update", this.transactions);
    return this.transactions;
  }

  async getTransaction(txid: string): Promise<TxView | null> {
    return this.conn.request<TxView | null>("GET", `/transactions/${encodeURIComponent(txid)}`);
  }

  getPeers(): PeerView[] {
    return this.conn.snapshot();
  }

  getConnectionCount(): number {
    return this.conn.connectedCount;
  }

  async getMiningInfo(): Promise<MiningInfo> {
    const info = await this.conn.request<Record<string, unknown>>("GET", "/chain/info");
    return {
      difficulty: String(info.difficulty ?? "0"),
      networkHashps: Number(info.networkHashps ?? info.networkPower ?? 0),
      hashrate: 0,
    };
  }

  async getMiningJob(): Promise<Record<string, unknown>> {
    const job = await this.conn.request<Record<string, unknown>>("POST", "/mining/template", {
      address: this.key.address,
    });
    const block = job.block as { header?: { previousHash?: string } } | undefined;
    return {
      jobId: job.jobId,
      height: job.height,
      previousblockhash: block?.header?.previousHash,
      blob: job.blobHex,
      seedHash: job.seedHash,
      target: job.targetHex,
      difficulty: job.difficulty,
      coinbasevalue: this.chain.blockReward,
    };
  }

  getBlockCount(): number {
    return this.chain.height;
  }

  async resync(): Promise<void> {
    this.log.info("Rebuilding encrypted wallet chain database");
    this.database.rebuild();
    this.chain.setSync({ localHeight: 0, syncStatus: "syncing", syncError: null, lastBlockTime: null });
    await this.refreshChain();
    this.database.save();
  }

  private async synchronizeLocalDatabase(networkHeight: number, expectedGenesisHash: string): Promise<void> {
    try {
      let localHeight = this.database.localHeight();
      if (localHeight > networkHeight) {
        this.database.truncate(networkHeight);
        localHeight = this.database.localHeight();
      }
      while (localHeight < networkHeight) {
        const startHeight = Math.max(0, localHeight + 1);
        const response = await this.conn.requestTransport("GET", `/chain/blocks?start=${startHeight}&limit=200`);
        if (response.status < 200 || response.status >= 300) throw new Error(`node returned HTTP ${response.status}`);
        const page = (response.data as { items?: unknown[] }).items ?? [];
        const first = page[0] as { header?: { height?: number } } | undefined;
        if (page.length === 0 || first?.header?.height !== startHeight) {
          throw new ChainDataError(`node did not return block ${startHeight}`);
        }
        if (startHeight === 0 && expectedGenesisHash && (page[0] as { hash?: string }).hash !== expectedGenesisHash) {
          throw new ChainDataError("local wallet database genesis does not match the selected node");
        }
        this.database.appendBlocks(page as Parameters<ChainStore["appendBlocks"]>[0]);
        this.database.save();
        localHeight = this.database.localHeight();
        this.chain.setSync({
          localHeight: Math.max(0, localHeight),
          lastBlockTime: this.database.localTip().ts || null,
        });
        this.bus.emit("chain:update", this.chain.toView());
      }
      this.chain.setSync({
        localHeight: Math.max(0, this.database.localHeight()),
        syncStatus: "synced",
        syncError: null,
        lastBlockTime: this.database.localTip().ts || null,
      });
    } catch (error) {
      const reason = error instanceof ChainDataError ? error.message : (error as Error).message;
      this.chain.setSync({
        localHeight: Math.max(0, this.database.localHeight()),
        syncStatus: "error",
        syncError: reason,
      });
      throw error;
    }
  }
}
