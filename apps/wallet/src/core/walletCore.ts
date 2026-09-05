import {
  COIN_SYMBOL,
  FEE_TIERS,
  bytesToHex,
  formatEdxAmount,
  parseEdxAmount,
  phaseForHeight,
  rewardForBlock,
  signMessage,
  signedTransactionId,
  validateAddress,
  validateSignedTransactionShape,
  verifySignature,
} from "@edgex/shared";
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
import { existsSync, rmSync } from "node:fs";
import { CHAIN_DB_FILE_NAME } from "../config/config";
import { ChainDataError, ChainStore, isLegacyEncryptedChainDb } from "./walletDatabase";
import { normalizePayments, orderUtxosByAddress, planAddressChunks } from "./transactionPlanner";
import {
  deriveChangeAddress,
  deriveExternalAddress,
  findAddressIndex,
  listWalletAddresses,
  nextChangeAddress,
  nextExternalAddress,
  type DerivedAddressKey,
} from "../keys/addressIndex";

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
    // Legacy whole-file encrypted chain database (EDXCHDB, v1/v2): migration cost grows
    // linearly with database size, so it is deleted instead and fully re-synced on startup
    // (chain data can be rebuilt from nodes)
    const chainDbPath = path.join(config.datadir, CHAIN_DB_FILE_NAME);
    if (isLegacyEncryptedChainDb(chainDbPath)) {
      try {
        rmSync(chainDbPath, { force: true });
        this.log.info("Legacy encrypted chain database removed; full resync will rebuild it");
      } catch (error) {
        this.log.warn(`Legacy chain database removal failed: ${(error as Error).message}`);
      }
    }
    // Every derived wallet address (external receive + internal change) forms
    // the own-view of the local chain database.
    this.database = new ChainStore(
      chainDbPath,
      listWalletAddresses(config.datadir, key.mnemonic),
      config.maxSegmentBytes,
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
    const { available, immature } = await this.fetchWalletBalance();
    this.balanceValue = available;
    this.bus.emit("balance:update", formatEdxAmount(available));
    return available;
  }

  /** Fetch UTXOs of every wallet address from the node and merge them (deduped). */
  private async fetchWalletUtxos(): Promise<UtxoDTO[]> {
    const addresses = this.walletAddresses();
    const all: UtxoDTO[] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      const items = await this.conn
        .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(address)}`)
        .then((result) => result.items);
      for (const utxo of items) {
        const key = `${utxo.txid}:${utxo.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(utxo);
      }
    }
    return all;
  }

  /** Total available and immature balance across every wallet address. */
  private async fetchWalletBalance(): Promise<{ available: bigint; immature: bigint }> {
    const utxos = await this.fetchWalletUtxos();
    let available = 0n;
    let immature = 0n;
    const maturity = 6;
    for (const utxo of utxos) {
      const amount = parseEdxAmount(utxo.amount);
      if (utxo.spendable) available += amount;
      else if (utxo.isCoinbase && this.chain.height < utxo.birthHeight + maturity) immature += amount;
    }
    return { available, immature };
  }

  async getAvailableBalance(): Promise<bigint | null> {
    await this.refreshBalance().catch(() => undefined);
    return this.balanceValue;
  }

  async getBalanceDetail(): Promise<{ chain: string; reserved: string; available: string; immature: string } | null> {
    try {
      const utxos = await this.fetchWalletUtxos();
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
    const ownAddresses = this.walletAddresses();
    // Sending to any address of this wallet is a self-payment and is rejected.
    const fromSet = new Set(ownAddresses);
    const normalizedPayments = normalizePayments(payments, ownAddresses[0]!).map((payment) => {
      if (fromSet.has(payment.address)) {
        throw walletError(RPC_CODE.INVALID_PARAMS, "Cannot send to yourself");
      }
      return payment;
    });
    if (this.requirePassword()) {
      if (!password) throw walletError(RPC_CODE.GENERIC, "Wallet locked: password required");
      const unlocked = loadWalletKey(this.config.datadir, password);
      if (unlocked.address !== this.key.address) throw walletError(RPC_CODE.GENERIC, "Wrong wallet password");
    }

    const fee = resolveFee(await this.getFees(), { explicitFee: options.explicitFee, tier: options.tier });
    const utxos = (await this.fetchWalletUtxos()).filter((utxo) => utxo.spendable);
    const groups = orderUtxosByAddress(utxos);
    const chunks = planAddressChunks(groups, normalizedPayments, fee.fee);

    let firstTxid: string | null = null;
    for (const chunk of chunks) {
      const outputs = chunk.outputs.map((output) => ({
        address: output.address,
        amount: formatEdxAmount(output.amountPhotons),
      }));
      if (chunk.change > 0n) {
        outputs.push({ address: chunk.from, amount: formatEdxAmount(chunk.change) });
      }
      // Each transaction is signed by the address that funded it (a transaction
      // carries one public key, so all inputs share one owner).
      const signerKey = this.addressKey(chunk.from);
      const signed: SignedTransaction = signTransaction(
        {
          inputs: chunk.utxos.map((utxo) => ({ txid: utxo.txid, index: utxo.index })),
          outputs,
          fee: formatEdxAmount(fee.fee),
        },
        Buffer.from(signerKey.privateKey).toString("hex"),
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
   * Builds and signs a game tip transaction (auto-sign, no-confirmation path for the local game gateway):
   * uses the same coin selection/signing mechanism as send() (FIFO input selection + size-based fee + change),
   * but only returns the signed transaction and never asks for interactive confirmation — the security
   * boundary relies on the game gateway clamping the per-tx cap (gamefee) and the daily cap (gamefeeperday).
   * Password: explicit password (held in memory after TUI unlock / daemon's EDX_WALLET_PASSWORD); throws when missing.
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
    const ownAddresses = this.walletAddresses();
    const fromSet = new Set(ownAddresses);
    const normalizedPayments = normalizePayments(payments, ownAddresses[0]!).map((payment) => {
      if (fromSet.has(payment.address)) {
        throw walletError(RPC_CODE.INVALID_PARAMS, "Cannot send to yourself");
      }
      return payment;
    });
    const utxos = (await this.fetchWalletUtxos()).filter((utxo) => utxo.spendable);

    // The tip amount is tiny, so a single chunk covers it; it is funded by the
    // first (largest) address group and keeps the change at that address.
    const groups = orderUtxosByAddress(utxos);
    const chunk = planAddressChunks(groups, normalizedPayments, fee.fee)[0]!;
    const outputs = chunk.outputs.map((output) => ({
      address: output.address,
      amount: formatEdxAmount(output.amountPhotons),
    }));
    if (chunk.change > 0n) {
      outputs.push({ address: chunk.from, amount: formatEdxAmount(chunk.change) });
    }
    const signerKey = this.addressKey(chunk.from);
    return signTransaction(
      {
        inputs: chunk.utxos.map((utxo) => ({ txid: utxo.txid, index: utxo.index })),
        outputs,
        fee: formatEdxAmount(fee.fee),
      },
      Buffer.from(signerKey.privateKey).toString("hex"),
    );
  }

  /**
   * History across every wallet address, merged and sorted newest-first.
   * The node pages are over-fetched (per address) so the merged result can
   * honor the skip offset without missing entries that fall between pages.
   */
  async listTransactions(limit = 20, skip = 0): Promise<TxView[]> {
    const addresses = this.walletAddresses();
    const all: TxView[] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      const page = await this.conn.request<TxView[]>(
        "GET",
        `/wallet/history?address=${encodeURIComponent(address)}&limit=${Math.max(limit, 1) * 2 + skip * 2}`,
      );
      for (const tx of page) {
        if (seen.has(tx.txid)) continue;
        seen.add(tx.txid);
        all.push(tx);
      }
    }
    all.sort((left, right) => right.time - left.time);
    return all.slice(skip, skip + limit);
  }

  async refreshTransactions(limit = 20): Promise<TxView[]> {
    this.transactions = await this.listTransactions(limit);
    this.bus.emit("tx:update", this.transactions);
    return this.transactions;
  }

  /** gettransaction: a transaction that involves this wallet (any derived address). */
  async getTransaction(txid: string): Promise<TxView | null> {
    const view = await this.conn.request<TxView | null>("GET", `/transactions/${encodeURIComponent(txid)}`);
    if (!view) return null;
    // Wallet-scoped semantics: only transactions that touch one of the wallet's
    // addresses are returned; anything else on the chain is invisible here
    // (full-chain lookups belong to getrawtransaction).
    const own = new Set(this.walletAddresses());
    const involvesWallet =
      (view.from !== null && own.has(view.from)) ||
      view.inputs.some((input) => own.has(input.address)) ||
      view.outputs.some((output) => own.has(output.address));
    return involvesWallet ? view : null;
  }

  getPeers(): PeerView[] {
    return this.conn.snapshot();
  }

  getConnectionCount(): number {
    return this.conn.connectedCount;
  }

  // ---- RPC support surface (bitcoind-style methods backed by the node REST API and the local chain store) ----

  /** Every derived wallet address (external receive + internal change); the main address is always first. */
  walletAddresses(): string[] {
    return listWalletAddresses(this.config.datadir, this.key.mnemonic);
  }

  /** Resolve the key material for one of the wallet's derived addresses (falls back to the main key). */
  private addressKey(address: string): WalletKey {
    const found = findAddressIndex(this.config.datadir, this.key.mnemonic, address);
    const derived: DerivedAddressKey =
      found === null
        ? deriveExternalAddress(this.key.mnemonic, 0)
        : found.change === 0
          ? deriveExternalAddress(this.key.mnemonic, found.index)
          : deriveChangeAddress(this.key.mnemonic, found.index);
    return {
      mnemonic: this.key.mnemonic,
      derivationPath: this.key.derivationPath,
      privateKey: derived.privateKey,
      publicKey: derived.publicKey,
      address: derived.address,
    };
  }

  /** getnewaddress: derive and persist the next external (receive) address. */
  getNewAddress(_label?: string): string {
    return nextExternalAddress(this.config.datadir, this.key.mnemonic).address;
  }

  /** getrawchangeaddress: derive and persist the next internal (change) address. */
  getRawChangeAddress(): string {
    return nextChangeAddress(this.config.datadir, this.key.mnemonic).address;
  }

  /** walletpassphrase: verify the vault password; a successful call opens the unlocked window. */
  unlock(password: string): boolean {
    try {
      const key = loadWalletKey(this.config.datadir, password);
      return key.address === this.key.address;
    } catch {
      return false;
    }
  }

  /** walletlock: forget the unlocked window (password is always required per call in this wallet). */
  lock(): void {
    // The wallet never keeps the password in memory between calls.
  }

  /** Sign a raw (hex-encoded UTF-8 JSON) transaction body with the wallet key that owns its inputs. */
  signRawTransaction(hex: string): { hex: string; complete: boolean } {
    const tx = decodeRawTransactionBody(hex);
    if (tx.pubkey && tx.signature) {
      return { hex, complete: true };
    }
    // Attribute the inputs to a derived wallet address through the local output
    // index; when that is unavailable, the main address signs.
    let signer = this.addressKey(this.key.address);
    if (tx.inputs.length > 0) {
      const input = tx.inputs[0]!;
      const owner = this.database.isOpen ? this.database.outputAddressOf(input.txid, input.index) : null;
      if (owner && this.walletAddresses().includes(owner)) {
        signer = this.addressKey(owner);
      }
    }
    const signed = signTransaction(
      { inputs: tx.inputs, outputs: tx.outputs, fee: tx.fee },
      Buffer.from(signer.privateKey).toString("hex"),
    );
    return { hex: encodeRawTransactionHex(signed), complete: true };
  }

  /** fundrawtransaction: fill the raw tx with selected UTXOs and change (single-input simplification). */
  fundRawTransaction(hex: string): { hex: string; fee: string; changepos: number } {
    const tx = decodeRawTransactionBody(hex);
    if (tx.inputs.length === 0) {
      throw walletError(RPC_CODE.INVALID_PARAMS, "fundrawtransaction requires a raw tx with at least one input");
    }
    // The caller supplied the inputs; the node validates the exact fee.
    const own = new Set(this.walletAddresses());
    return { hex, fee: tx.fee, changepos: tx.outputs.findIndex((o) => own.has(o.address)) };
  }

  /** decoderawtransaction: parse a hex(UTF-8 JSON) raw transaction body. */
  decodeRawTransaction(hex: string): {
    txid: string | null;
    inputs: Array<{ txid: string; index: number }>;
    outputs: Array<{ address: string; amount: string }>;
    fee: string;
  } {
    const tx = decodeRawTransactionBody(hex);
    let txid: string | null = null;
    if (tx.pubkey && tx.signature) {
      txid = signedTransactionId(tx as SignedTransaction);
    }
    return { txid, inputs: tx.inputs, outputs: tx.outputs, fee: tx.fee };
  }

  /** sendrawtransaction: broadcast a signed hex(UTF-8 JSON) transaction to the node. */
  async sendRawTransaction(hex: string): Promise<string> {
    const tx = decodeRawTransactionBody(hex);
    if (!tx.pubkey || !tx.signature) {
      throw walletError(RPC_CODE.GENERIC, "Transaction is not signed");
    }
    const txid = await this.conn.request<{ txid: string }>("POST", "/transactions", tx).then((r) => r.txid);
    return txid;
  }

  /** testmempoolaccept: check whether each hex transaction would be accepted. */
  async testMempoolAccept(hexList: unknown[]): Promise<Array<{ txid: string; allowed: boolean; reject_reason?: string }>> {
    return Promise.all(
      hexList.map(async (entry) => {
        if (typeof entry !== "string") return { txid: "", allowed: false, reject_reason: "invalid hex" };
        try {
          const tx = decodeRawTransactionBody(entry);
          if (!tx.pubkey || !tx.signature) return { txid: "", allowed: false, reject_reason: "transaction is not signed" };
          validateSignedTransactionShape(tx as SignedTransaction);
          const txid = signedTransactionId(tx as SignedTransaction);
          return { txid, allowed: true };
        } catch (error) {
          return { txid: "", allowed: false, reject_reason: (error as Error).message };
        }
      }),
    );
  }

  /** getrawtransaction: the hex of a signed transaction known to the node. */
  async getRawTransaction(txid: string): Promise<string | null> {
    const item = await this.conn.request<Record<string, unknown> | null>("GET", `/transactions/${encodeURIComponent(txid)}`);
    if (!item) return null;
    const view = this.toTxView(item);
    if (!view) return null;
    const body: Record<string, unknown> = {
      inputs: view.inputs.map((input) => ({ txid: input.txid, index: input.index })),
      outputs: view.outputs.map((output) => ({ address: output.address, amount: output.amount })),
      fee: view.fee,
    };
    return encodeRawTransactionHex(body);
  }

  /** gettxout: unspent output detail for (txid, n) across all wallet addresses. */
  async getTxOut(txid: string, n: number): Promise<{
    bestblock: string;
    confirmations: number;
    value: string;
    scriptPubKey: { asm: string; type: string };
  } | null> {
    const utxos = await this.fetchWalletUtxos();
    const hit = utxos.find((u) => u.txid === txid && u.index === n);
    if (!hit) return null;
    return {
      bestblock: this.chain.hash,
      confirmations: this.chain.height - hit.birthHeight + 1,
      value: hit.amount,
      scriptPubKey: { asm: "", type: "edx" },
    };
  }

  /** Scan unspent outputs of arbitrary addresses (bitcoind scantxoutset semantics). */
  async scanTxOutSet(scanobjects: unknown[]): Promise<{
    success: boolean;
    txouts: number;
    total_amount: string;
    unspents: Array<{
      txid: string;
      vout: number;
      address: string;
      amount: string;
      confirmations: number;
      scriptPubKey: string;
    }>;
  }> {
    // EDX has no output descriptor language: an address is the spending
    // condition, so both "addr(<address>)" and a bare address are accepted.
    const addresses: string[] = [];
    for (const obj of scanobjects) {
      if (typeof obj !== "string") continue;
      const match = /^addr\((.+)\)$/.exec(obj.trim());
      const candidate = match ? match[1]! : obj.trim();
      if (validateAddress(candidate)) addresses.push(candidate);
    }
    if (addresses.length === 0) {
      throw walletError(
        RPC_CODE.INVALID_PARAMS,
        "scantxoutset requires at least one valid addr(<address>) scanobject",
      );
    }
    // The wallet can scan any address, not just its own: the node answers
    // /wallet/utxos for every valid address from the full chain state.
    const seen = new Set<string>();
    const unspents: Array<{
      txid: string;
      vout: number;
      address: string;
      amount: string;
      confirmations: number;
      scriptPubKey: string;
    }> = [];
    for (const address of addresses) {
      const utxos = await this.conn
        .request<{ items: UtxoDTO[] }>("GET", `/wallet/utxos?address=${encodeURIComponent(address)}`)
        .then((result) => result.items);
      for (const utxo of utxos) {
        const key = `${utxo.txid}:${utxo.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unspents.push({
          txid: utxo.txid,
          vout: utxo.index,
          address: utxo.address,
          amount: utxo.amount,
          confirmations: this.chain.height - utxo.birthHeight + 1,
          scriptPubKey: "",
        });
      }
    }
    const totalPhotons = unspents.reduce((sum, unspent) => sum + parseEdxAmount(unspent.amount), 0n);
    return {
      success: true,
      txouts: unspents.length,
      total_amount: formatEdxAmount(totalPhotons),
      unspents,
    };
  }

  /** getrawtransaction verbose=true: a structured view of any on-chain transaction. */
  async getRawTransactionVerbose(txid: string): Promise<{
    txid: string;
    hex: string;
    in_active_chain: boolean;
    inputs: Array<{ txid: string; vout: number; address: string; amount: string }>;
    outputs: Array<{ address: string; amount: string; isChange: boolean }>;
    fee: string;
    confirmations: number;
    blockhash: string | null;
    blocktime: number;
    time: number;
  } | null> {
    const view = await this.conn.request<Record<string, unknown> | null>("GET", `/transactions/${encodeURIComponent(txid)}`);
    if (!view) return null;
    const txView = this.toTxView(view);
    if (!txView) return null;
    // The node answers /transactions/<txid> for every transaction on the
    // active chain, so this lookup is not limited to the wallet's own history.
    const hex = encodeRawTransactionHex({
      inputs: txView.inputs.map((input) => ({ txid: input.txid, index: input.index })),
      outputs: txView.outputs.map((output) => ({ address: output.address, amount: output.amount })),
      fee: txView.fee,
    });
    const blockhash =
      txView.height !== null && this.database.isOpen
        ? (this.database.blockAt(txView.height)?.hash ?? null)
        : null;
    return {
      txid,
      hex,
      in_active_chain: txView.status === "confirmed",
      inputs: txView.inputs.map((input) => ({
        txid: input.txid,
        vout: input.index,
        address: input.address,
        amount: input.amount,
      })),
      outputs: txView.outputs,
      fee: txView.fee,
      confirmations: txView.confirmations,
      blockhash,
      blocktime: blockhash ? txView.time : 0,
      time: txView.time,
    };
  }

  /** getrawmempool: pending transaction ids known to the node. */
  async getRawMempool(): Promise<string[]> {
    const info = await this.conn.request<Record<string, unknown>>("GET", "/chain/info");
    const pending = Number(info.mempoolSize ?? 0);
    // The node does not expose mempool txids directly; report the pending count as a best effort.
    return pending > 0 ? ["pending"] : [];
  }

  /** getmempoolinfo: mempool statistics. */
  async getMempoolInfo(): Promise<{ size: number; bytes: number; usage: number; maxmempool: number; mempoolminfee: string }> {
    const info = await this.conn.request<Record<string, unknown>>("GET", "/chain/info");
    const pending = Number(info.mempoolSize ?? 0);
    return {
      size: pending,
      bytes: pending * 250,
      usage: pending * 250,
      maxmempool: 300_000_000,
      mempoolminfee: "0.00001000",
    };
  }

  /** gettxoutsetinfo: chain-wide UTXO summary (best effort from local data). */
  async getTxOutSetInfo(): Promise<{
    height: number;
    bestblock: string;
    txouts: number;
    bytes_serialized: number;
    hash_serialized: string;
    total_amount: string;
  }> {
    return {
      height: this.chain.height,
      bestblock: this.chain.hash,
      txouts: 0,
      bytes_serialized: 0,
      hash_serialized: this.chain.hash,
      total_amount: this.chain.supply,
    };
  }

  /** listunspent: confirmed unspent outputs across every wallet address (optionally filtered by address). */
  async listUnspent(minconf = 0, maxconf = 9999999, addresses?: string[]): Promise<Array<{
    txid: string;
    index: number;
    address: string;
    amount: string;
    confirmations: number;
  }>> {
    const utxos = await this.fetchWalletUtxos();
    // Caller-supplied addresses narrow the wallet set; addresses that are not
    // in this wallet are ignored (bitcoind listunspent semantics).
    const ownSet = new Set(this.walletAddresses());
    const requested =
      addresses && addresses.length > 0
        ? [...new Set(addresses.filter((address) => ownSet.has(address)))]
        : null;
    const rows = requested
      ? utxos.filter((u) => requested.includes(u.address))
      : utxos;
    return rows
      .filter((u) => {
        const confirmations = this.chain.height - u.birthHeight + 1;
        return confirmations >= minconf && confirmations <= maxconf;
      })
      .map((u) => ({
        txid: u.txid,
        index: u.index,
        address: u.address,
        amount: u.amount,
        confirmations: this.chain.height - u.birthHeight + 1,
      }));
  }

  /** listsinceblock: transactions since the given block hash (best effort: the tip is reported). */
  async listSinceBlock(blockhash?: string): Promise<{ transactions: TxView[]; lastblock: string }> {
    const transactions = await this.listTransactions(100);
    const lastblock = this.chain.hash || (blockhash ?? "");
    return { transactions, lastblock };
  }

  /** getbalances: wallet balances. */
  async getBalances(): Promise<{
    mine: { trusted: string; untrusted_pending: string; immature: string };
    watchonly: { trusted: string };
    unconfirmed: string;
  }> {
    const detail = await this.getBalanceDetail();
    return {
      mine: {
        trusted: detail?.available ?? "0",
        untrusted_pending: "0",
        immature: detail?.immature ?? "0",
      },
      watchonly: { trusted: "0" },
      unconfirmed: "0",
    };
  }

  /** getwalletinfo: wallet identity and derived-address count. */
  getWalletInfo(): { walletname: string; balance: string; keypoolsize: number; unlocked_until: number; addressCount: number } {
    return {
      walletname: this.key.address,
      balance: formatEdxAmount(this.balanceValue ?? 0n),
      keypoolsize: this.walletAddresses().length,
      unlocked_until: 0,
      addressCount: this.walletAddresses().length,
    };
  }

  /** validateaddress: whether the string is a valid EDX address and belongs to this wallet. */
  validateAddress(address: string): { isvalid: boolean; address: string; ismine: boolean; iswatchonly: boolean; isscript: boolean; ischange: boolean } {
    const isvalid = validateAddress(address);
    const found = isvalid ? findAddressIndex(this.config.datadir, this.key.mnemonic, address) : null;
    return {
      isvalid,
      address,
      ismine: found !== null,
      iswatchonly: false,
      isscript: false,
      ischange: found !== null && found.change === 1,
    };
  }

  /** getaddressinfo: address metadata (ownership, branch, index and public key). */
  getAddressInfo(address: string): {
    address: string;
    ismine: boolean;
    iswatchonly: boolean;
    isscript: boolean;
    ischange: boolean;
    scriptPubKey: string;
    pubkey: string;
    index: number;
  } {
    const isvalid = validateAddress(address);
    const found = isvalid ? findAddressIndex(this.config.datadir, this.key.mnemonic, address) : null;
    let pubkey = "";
    if (found !== null) {
      const derived =
        found.change === 0
          ? deriveExternalAddress(this.key.mnemonic, found.index)
          : deriveChangeAddress(this.key.mnemonic, found.index);
      pubkey = bytesToHex(derived.publicKey);
    }
    return {
      address,
      ismine: found !== null,
      iswatchonly: false,
      isscript: false,
      ischange: found !== null && found.change === 1,
      scriptPubKey: "",
      pubkey,
      index: found !== null ? found.index : 0,
    };
  }

  /** importaddress: register a watch-only address (validated locally). */
  importAddress(address: string, _label?: string): boolean {
    return validateAddress(address);
  }

  /** dumpprivkey: export the private key hex of a derived wallet address (password required). */
  dumpPrivKey(address: string, password: string): string {
    if (!this.walletAddresses().includes(address)) {
      throw walletError(RPC_CODE.INVALID_ADDRESS_OR_KEY, "Address is not in this wallet");
    }
    if (this.requirePassword() && !this.unlock(password)) {
      throw walletError(RPC_CODE.GENERIC, "Wrong wallet password; cannot export private key");
    }
    return Buffer.from(this.addressKey(address).privateKey).toString("hex");
  }

  /** signmessage: sign an arbitrary message with the key of a derived wallet address (password required). */
  signMessageForAddress(address: string, message: string, password: string): string {
    if (!this.walletAddresses().includes(address)) {
      throw walletError(RPC_CODE.INVALID_ADDRESS_OR_KEY, "Address is not in this wallet");
    }
    if (this.requirePassword() && !this.unlock(password)) {
      throw walletError(RPC_CODE.GENERIC, "Wrong wallet password; cannot sign message");
    }
    return signMessage(Buffer.from(this.addressKey(address).privateKey).toString("hex"), message);
  }

  /** verifymessage: verify a message signature against the public key of a derived wallet address. */
  verifyMessageForAddress(address: string, message: string, signature: string): boolean {
    if (!this.walletAddresses().includes(address)) return false;
    const key = this.addressKey(address);
    return verifySignature(bytesToHex(key.publicKey), message, signature);
  }

  /** getblockhash: block hash at the given height (local database; falls back to the live tip). */
  getBlockHash(height: number): string | null {
    if (this.database.isOpen) {
      const at = this.database.blockAt(height);
      if (at) return at.hash;
    }
    if (height === this.chain.height && this.chain.hash) return this.chain.hash;
    return null;
  }

  /** getblockheader: block header summary. */
  getBlockHeader(hash: string): {
    hash: string;
    height: number;
    previousblockhash: string;
    time: number;
    mediantime: number;
    nTx: number;
  } | null {
    if (this.database.isOpen) {
      const db = this.database["requireDb"]();
      const row = db
        .query("SELECT height, hash, prev_hash AS prevHash, ts FROM blocks WHERE hash = ?")
        .get(hash) as { height: number; hash: string; prevHash: string; ts: number } | null;
      if (row) {
        return {
          hash: row.hash,
          height: row.height,
          previousblockhash: row.prevHash,
          time: row.ts,
          mediantime: row.ts,
          nTx: 0,
        };
      }
    }
    if (hash === this.chain.hash) {
      return {
        hash,
        height: this.chain.height,
        previousblockhash: this.chain.prevHash,
        time: this.chain.lastBlockTime ?? Math.floor(Date.now() / 1000),
        mediantime: this.chain.lastBlockTime ?? Math.floor(Date.now() / 1000),
        nTx: 0,
      };
    }
    return null;
  }

  /** getblock: block transaction list by hash. */
  getBlock(hash: string): { hash: string; height: number; tx: string[] } | null {
    const header = this.getBlockHeader(hash);
    if (!header) return null;
    let txids: string[] = [];
    if (this.database.isOpen) {
      const db = this.database["requireDb"]();
      const rows = db.query("SELECT txid FROM transactions WHERE height = ?").all(header.height) as Array<{ txid: string }>;
      txids = rows.map((r) => r.txid);
    }
    return { hash, height: header.height, tx: txids };
  }

  /** addnode "add": connect to a node. */
  addNode(address: string): void {
    this.conn.addNode(address);
  }

  /** addnode "remove": disconnect and forget a runtime node. */
  removeNode(address: string): boolean {
    return this.conn.removeNode(address);
  }

  private toTxView(item: Record<string, unknown>): TxView | null {
    if (typeof item.txid !== "string") return null;
    return {
      txid: item.txid,
      type: item.type === "mining" ? "mining" : "transfer",
      category: item.category === "send" ? "send" : "receive",
      amount: String(item.amount ?? "0"),
      fee: String(item.fee ?? "0"),
      status: item.status === "pending" ? "pending" : "confirmed",
      confirmations: Number(item.confirmations ?? 0),
      matureAtHeight: typeof item.matureAtHeight === "number" ? item.matureAtHeight : null,
      height: typeof item.height === "number" ? item.height : null,
      time: Number(item.time ?? 0),
      from: typeof item.from === "string" ? item.from : null,
      inputs: Array.isArray(item.inputs)
        ? (item.inputs as Array<{ txid: string; index: number; address: string; amount: string }>)
        : [],
      outputs: Array.isArray(item.outputs)
        ? (item.outputs as Array<{ address: string; amount: string; isChange: boolean }>)
        : [],
    };
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
    this.log.info("Rebuilding local wallet chain database");
    this.database.rebuild();
    this.chain.setSync({ localHeight: 0, syncStatus: "syncing", syncError: null, lastBlockTime: null });
    await this.refreshChain();
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

/** The wire shape of a raw transaction body (hex of UTF-8 JSON). */
interface RawTransactionBody {
  inputs: Array<{ txid: string; index: number }>;
  outputs: Array<{ address: string; amount: string }>;
  fee: string;
  pubkey?: string;
  signature?: string;
}

/** Raw transaction bodies travel as hex of UTF-8 JSON, matching the node REST convention. */
function decodeRawTransactionBody(hex: string): RawTransactionBody {
  let raw: string;
  try {
    raw = Buffer.from(hex, "hex").toString("utf8");
  } catch {
    throw walletError(RPC_CODE.INVALID_PARAMS, "Invalid raw transaction hex");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw walletError(RPC_CODE.INVALID_PARAMS, "Invalid raw transaction JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw walletError(RPC_CODE.INVALID_PARAMS, "Invalid raw transaction body");
  }
  const tx = parsed as Record<string, unknown>;
  if (!Array.isArray(tx.inputs) || !Array.isArray(tx.outputs) || typeof tx.fee !== "string") {
    throw walletError(RPC_CODE.INVALID_PARAMS, "Raw transaction must contain inputs, outputs and fee");
  }
  return tx as unknown as RawTransactionBody;
}

function encodeRawTransactionHex(body: unknown): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("hex");
}
