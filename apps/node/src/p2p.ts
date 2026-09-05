import type { ServerWebSocket } from 'bun';
import { NETWORK_ID } from '@edgex/shared';
import type { Block } from '@edgex/core';
import type { SignedTransaction } from '@edgex/shared';

/** Status snapshot of the local best chain. */
export interface PeerChainStatus {
  height: number;
  bestHash: string;
  totalWork: string;
}

/**
 * Read-only view of the local chain that the peer layer drives block download
 * and reorganization from. The node app implements this over the consensus
 * chain and its persisted store.
 */
export interface PeerDataSource {
  status(): PeerChainStatus;
  /** Block at the given height on the best chain, or null when out of range. */
  chainAtHeight(height: number): Block | null;
  /** Cumulative work of the block with the given hash, or null when unknown. */
  cumulativeWorkFrom(hashHex: string): bigint | null;
  /** Whether the block with the given hash is known locally (any branch). */
  has(hashHex: string): boolean;
  peerStatus(): { connected: number; total: number; items: Array<{ address: string; connected: boolean; source: string }> };
}

export type P2PRpcHandler = (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
) => Promise<{ status: number; data: unknown }>;

type PeerMessage =
  | { type: 'hello'; nodeId?: string; networkId: string; height: number; bestHash: string; totalWork?: string; advertisedUrl?: string }
  | { type: 'peers'; peers: unknown }
  | { type: 'transaction'; transaction: SignedTransaction }
  | { type: 'block'; block: Block }
  | { type: 'rpc_request'; id: string; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { type: 'rpc_result'; id: string; status: number; data?: unknown; error?: string }
  | { type: 'get_tip'; id: string }
  | { type: 'tip'; id: string; height: number; bestHash: string; totalWork: string }
  | { type: 'get_blocks'; id: string; start: number; limit?: number }
  | { type: 'blocks'; id: string; start: number; items: unknown[] }
  | { type: 'locate'; id: string; hashes: string[] }
  | { type: 'locate_result'; id: string; index: number };

type SocketLike = WebSocket | ServerWebSocket<PeerState>;

interface PeerState {
  nodeId?: string;
  networkId?: string;
  advertisedUrl?: string;
  fullNode?: boolean;
  rpcTokens?: number;
  rpcRefilledAt?: number;
  activeRpcRequests?: number;
}

interface OutboundPeer {
  url: string;
  socket?: WebSocket | undefined;
  attempts: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  advertisedUrl?: string | undefined;
  fullNode?: boolean;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OutboundPeerSnapshot {
  url: string;
  connected: boolean;
  attempts: number;
  reconnecting: boolean;
}

const MAX_PEERS = 128;
const MAX_ADVERTISED_PEERS = 32;
const MAX_PEER_ANNOUNCEMENTS = 64;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SYNC_INTERVAL_MS = 2_000;
const SYNC_PEER_COOLDOWN_MS = 1_000;
const BLOCKS_PAGE_SIZE = 200;
const MAX_BLOCKS_PER_SYNC_RUN = 3_000;
const LOCATE_MAX_HASHES = 64;

/**
 * Consensus-authenticated gossip, request/response and block-sync surface.
 * Peers are trusted only through blocks that pass local consensus validation:
 * every downloaded block is handed to the injected accept callback and only
 * takes effect when the consensus chain keeps it.
 */
export class P2PNetwork {
  private readonly inbound = new Set<ServerWebSocket<PeerState>>();
  private readonly outbound = new Map<string, OutboundPeer>();
  private readonly connectionPending = new WeakMap<SocketLike, Map<string, PendingRequest>>();
  private server?: ReturnType<typeof Bun.serve<PeerState>>;
  private rpcHandler?: P2PRpcHandler | undefined;
  private dataSource?: PeerDataSource | undefined;
  private stopped = false;
  private selfUrl: string | undefined;
  private peerId: string;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncRunning = false;
  private readonly lastSyncAt = new Map<SocketLike, number>();
  private fetchedBlocks = 0;
  private requestCounter = 0;

  /** Install the loopback-equivalent public API handler used by wallet peers. */
  setRpcHandler(handler: P2PRpcHandler): void {
    this.rpcHandler = handler;
  }

  /** Install the local chain reader used by block download and reorganization. */
  setPeerDataSource(source: PeerDataSource): void {
    this.dataSource = source;
  }

  /**
   * Call whenever the local best chain advanced so the peer layer immediately
   * checks connected full nodes for a longer or heavier chain.
   */
  notifyChainAdvanced(): void {
    if (this.stopped || !this.dataSource) return;
    this.scheduleSyncTick(0);
  }

  /** @internal test probe: whether a sync pass is currently running. */
  get syncActiveProbe(): boolean {
    return this.syncRunning;
  }

  /** @internal test probe: total blocks received through block-sync requests. */
  get blocksFetchedCount(): number {
    return this.fetchedBlocks;
  }

  constructor(
    private readonly port: number,
    nodeId?: string | undefined,
    private readonly status: () => { height: number; bestHash: string; totalWork?: string } = () => ({ height: 0, bestHash: '' }),
    private readonly onTransaction?: (transaction: SignedTransaction) => void,
    private readonly onBlock?: (block: Block) => void,
    publicUrl?: string | undefined,
    private readonly webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {
    this.peerId = nodeId && isValidNodeId(nodeId) ? nodeId : fallbackNodeId();
    this.selfUrl = normalizePeerUrl(publicUrl ?? '');
  }

  /** Set the externally reachable address after an ephemeral port is bound. */
  setPublicUrl(url: string): void {
    this.selfUrl = normalizePeerUrl(url);
  }

  start(seeds: readonly string[]): void {
    this.stopped = false;
    this.server = Bun.serve<PeerState>({
      port: this.port,
      fetch: (request, server) => {
        if (server.upgrade(request, { data: {} })) return undefined;
        return new Response('EdgeX WebSocket endpoint', { status: 426 });
      },
      websocket: {
        open: (socket) => {
          socket.data = {};
          this.inbound.add(socket);
          socket.send(JSON.stringify(this.hello()));
        },
        message: (socket, message) => this.handleInbound(socket, message),
        close: (socket) => {
          this.inbound.delete(socket);
          this.rejectConnection(socket, new Error('P2P peer disconnected'));
          this.lastSyncAt.delete(socket);
        },
      },
    });

    for (const seed of seeds.slice(0, MAX_PEERS)) this.connect(seed);
    if (this.dataSource) this.scheduleSyncTick(0);
  }

  /** Connect (or schedule a connection) to a validated WebSocket peer URL. */
  connect(url: string): void {
    const normalized = normalizePeerUrl(url);
    if (!normalized || normalized === this.selfUrl || this.outbound.has(normalized)) return;
    if (this.outbound.size >= MAX_PEERS) return;

    const peer: OutboundPeer = { url: normalized, attempts: 0 };
    this.outbound.set(normalized, peer);
    this.scheduleConnect(peer, 0);
  }

  broadcast(message: PeerMessage): void {
    const payload = JSON.stringify(message);
    for (const peer of this.inbound) {
      if (peer.readyState === WebSocket.OPEN) peer.send(payload);
    }
    for (const peer of this.outbound.values()) {
      if (peer.socket?.readyState === WebSocket.OPEN) peer.socket.send(payload);
    }
  }

  get peerCount(): number {
    let count = this.inbound.size;
    for (const peer of this.outbound.values()) {
      if (peer.socket?.readyState === WebSocket.OPEN) count += 1;
    }
    return count;
  }

  get boundPort(): number | undefined {
    return this.server?.port;
  }

  get nodeId(): string {
    return this.peerId;
  }

  knownPeerUrls(excludeUrl?: string): string[] {
    const excluded = normalizePeerUrl(excludeUrl ?? '');
    const urls = new Set<string>();
    if (this.selfUrl && this.selfUrl !== excluded) urls.add(this.selfUrl);
    for (const socket of this.inbound) {
      const url = normalizePeerUrl(socket.data.advertisedUrl ?? '');
      if (url && url !== excluded) urls.add(url);
    }
    for (const peer of this.outbound.values()) {
      if (peer.socket?.readyState !== WebSocket.OPEN || peer.url === excluded) continue;
      urls.add(normalizePeerUrl(peer.advertisedUrl ?? '') || peer.url);
    }
    return [...urls].slice(0, MAX_ADVERTISED_PEERS);
  }

  outboundSnapshot(): OutboundPeerSnapshot[] {
    return [...this.outbound.values()].map((peer) => ({
      url: peer.url,
      connected: peer.socket?.readyState === WebSocket.OPEN,
      attempts: peer.attempts,
      reconnecting: !peer.socket && peer.timer !== undefined,
    }));
  }

  stop(): void {
    this.stopped = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    for (const peer of this.outbound.values()) {
      if (peer.timer) clearTimeout(peer.timer);
      peer.timer = undefined;
      peer.socket?.close();
    }
    for (const socket of this.inbound) {
      this.rejectConnection(socket, new Error('P2P server stopped'));
      socket.close();
    }
    this.outbound.clear();
    this.inbound.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  // ---- Handshake and discovery ----

  private hello(): PeerMessage {
    return {
      type: 'hello',
      nodeId: this.peerId,
      networkId: NETWORK_ID,
      ...this.bestTip(),
      ...(this.selfUrl ? { advertisedUrl: this.selfUrl } : {}),
    };
  }

  private bestTip(): { height: number; bestHash: string; totalWork?: string } {
    const tip = this.dataSource ? this.dataSource.status() : this.status();
    return { height: tip.height, bestHash: tip.bestHash, ...(tip.totalWork ? { totalWork: tip.totalWork } : {}) };
  }

  private scheduleConnect(peer: OutboundPeer, delayMs: number): void {
    if (this.stopped) return;
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => void this.openOutbound(peer), delayMs);
  }

  private async openOutbound(peer: OutboundPeer): Promise<void> {
    if (this.stopped || peer.socket || this.outbound.get(peer.url) !== peer) return;
    peer.timer = undefined;
    peer.attempts += 1;

    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(peer.url);
    } catch {
      this.scheduleReconnect(peer);
      return;
    }

    socket.addEventListener('open', () => {
      if (this.stopped || this.outbound.get(peer.url) !== peer) {
        socket.close();
        return;
      }
      peer.socket = socket;
      peer.attempts = 0;
      socket.send(JSON.stringify(this.hello()));
    });

    socket.addEventListener('message', (event) => {
      this.handleOutboundMessage(peer, socket, event.data);
    });

    socket.addEventListener('close', () => {
      this.rejectConnection(socket, new Error(`P2P peer disconnected: ${peer.url}`));
      this.lastSyncAt.delete(socket);
      // A socket that never opened (factory failure, connect refused) must
      // still fall into the reconnect schedule.
      if (peer.socket !== socket && !peer.timer) {
        if (!this.stopped && this.outbound.get(peer.url) === peer) {
          this.scheduleConnect(peer, reconnectDelayMs(peer.attempts));
        }
        return;
      }
      peer.socket = undefined;
      peer.advertisedUrl = undefined;
      peer.fullNode = undefined;
      if (!this.stopped && this.outbound.get(peer.url) === peer) {
        this.scheduleConnect(peer, reconnectDelayMs(peer.attempts));
      }
    });
  }

  private scheduleReconnect(peer: OutboundPeer): void {
    if (!this.stopped && this.outbound.get(peer.url) === peer) {
      this.scheduleConnect(peer, reconnectDelayMs(peer.attempts));
    }
  }

  private handleInbound(socket: ServerWebSocket<PeerState>, raw: string | ArrayBuffer | Uint8Array): void {
    const message = parsePeerMessage(raw);
    if (!message) return;

    if (message.type === 'hello') {
      // An invalid handshake permanently closes this inbound connection.
      if (!this.acceptHello(socket, message)) socket.close();
      else socket.send(JSON.stringify({ type: 'peers', peers: this.knownPeerUrls(message.advertisedUrl) }));
      return;
    }
    if (message.type === 'peers') {
      this.addDiscoveredPeers(message.peers);
      return;
    }
    if (message.type === 'rpc_request') void this.handleRpcRequest(socket, message);
    else this.handleCommonMessage(socket, message);
  }

  private handleOutboundMessage(
    peer: OutboundPeer,
    socket: WebSocket,
    raw: string | ArrayBuffer | Uint8Array,
  ): void {
    const message = parsePeerMessage(raw);
    if (!message) return;

    if (message.type === 'hello') {
      if (!this.acceptHello(socket, message, peer)) this.forgetPeer(peer, socket);
      return;
    }
    if (message.type === 'peers') {
      this.addDiscoveredPeers(message.peers);
      return;
    }
    this.handleCommonMessage(socket, message);
  }

  private acceptHello(
    socket: SocketLike,
    message: Extract<PeerMessage, { type: 'hello' }>,
    outboundPeer?: OutboundPeer,
  ): boolean {
    if (message.networkId !== NETWORK_ID) return false;
    if (message.nodeId !== undefined && !isValidNodeId(message.nodeId)) return false;
    const advertisedUrl = normalizePeerUrl(message.advertisedUrl ?? '');
    if (message.advertisedUrl && !advertisedUrl) return false;
    const fullNode = /^[0-9a-f]{64}$/.test(message.bestHash);

    if (outboundPeer) {
      outboundPeer.advertisedUrl = advertisedUrl || undefined;
      outboundPeer.fullNode = fullNode;
    } else {
      const inbound = socket as ServerWebSocket<PeerState>;
      inbound.data.nodeId = message.nodeId;
      inbound.data.networkId = message.networkId;
      inbound.data.advertisedUrl = advertisedUrl || undefined;
      inbound.data.fullNode = fullNode;
    }

    socket.send(JSON.stringify({ type: 'peers', peers: this.knownPeerUrls(outboundPeer ? outboundPeer.url : advertisedUrl) }));
    return true;
  }

  private forgetPeer(peer: OutboundPeer, socket: WebSocket): void {
    peer.timer = undefined;
    peer.socket = undefined;
    if (this.outbound.get(peer.url) === peer) this.outbound.delete(peer.url);
    this.rejectConnection(socket, new Error('invalid P2P handshake'));
    socket.close();
  }

  private addDiscoveredPeers(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value.slice(0, MAX_PEER_ANNOUNCEMENTS)) {
      if (typeof item === 'string') this.connect(item);
    }
  }

  // ---- Inbound request handling ----

  private handleCommonMessage(socket: SocketLike, message: PeerMessage): void {
    if (message.type === 'transaction') {
      this.onTransaction?.(message.transaction);
      return;
    }
    if (message.type === 'block') {
      this.onBlock?.(message.block);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;

    if (message.type === 'get_tip') {
      socket.send(JSON.stringify({ type: 'tip', id: message.id, ...this.bestTipWithDefault() }));
      return;
    }
    if (message.type === 'get_blocks') {
      this.serveBlocks(socket, message);
      return;
    }
    if (message.type === 'locate') {
      this.serveLocate(socket, message);
      return;
    }
    if (
      message.type === 'tip' ||
      message.type === 'blocks' ||
      message.type === 'locate_result' ||
      message.type === 'rpc_result'
    ) {
      this.resolveConnection(socket, message);
    }
  }

  private bestTipWithDefault(): { height: number; bestHash: string; totalWork: string } {
    const tip = this.bestTip();
    return { height: tip.height, bestHash: tip.bestHash, totalWork: tip.totalWork ?? '0' };
  }

  private serveBlocks(socket: SocketLike, message: Extract<PeerMessage, { type: 'get_blocks' }>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const start = Math.max(0, Math.trunc(Number(message.start) || 0));
    const limit = Math.max(1, Math.min(Math.trunc(Number(message.limit) || BLOCKS_PAGE_SIZE), BLOCKS_PAGE_SIZE));
    const items: unknown[] = [];
    if (this.dataSource) {
      const tipHeight = this.dataSource.status().height;
      for (let height = start; height <= tipHeight && items.length < limit; height += 1) {
        const block = this.dataSource.chainAtHeight(height);
        if (!block) break;
        items.push(serializeBlock(block));
      }
    }
    socket.send(JSON.stringify({ type: 'blocks', id: message.id, start, items }));
  }

  private serveLocate(socket: SocketLike, message: Extract<PeerMessage, { type: 'locate' }>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const hashes = Array.isArray(message.hashes)
      ? message.hashes.filter((hash): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)).slice(0, LOCATE_MAX_HASHES)
      : [];
    let index = -1;
    if (this.dataSource) {
      for (let position = 0; position < hashes.length; position += 1) {
        if (this.dataSource.cumulativeWorkFrom(hashes[position]!) !== null) {
          index = position;
          break;
        }
      }
    }
    socket.send(JSON.stringify({ type: 'locate_result', id: message.id, index }));
  }

  // ---- Inbound P2P RPC tunnel ----

  private async handleRpcRequest(
    socket: ServerWebSocket<PeerState>,
    message: Extract<PeerMessage, { type: 'rpc_request' }>,
  ): Promise<void> {
    const reply = (status: number, data: unknown, error?: string) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'rpc_result',
        id: message.id,
        status,
        data,
        ...(error ? { error } : {}),
      }));
    };

    if (!this.rpcHandler || !isValidRpcId(message.id) || !isValidRpcPath(message.path)) {
      reply(400, { error: 'invalid P2P RPC request' }, 'invalid P2P RPC request');
      return;
    }
    if (!consumeRpcBudget(socket)) {
      reply(429, { error: 'P2P RPC rate limit exceeded' }, 'P2P RPC rate limit exceeded');
      return;
    }
    if ((socket.data.activeRpcRequests ?? 0) >= 8) {
      reply(503, { error: 'P2P peer is busy' }, 'P2P peer is busy');
      return;
    }

    socket.data.activeRpcRequests = (socket.data.activeRpcRequests ?? 0) + 1;
    try {
      const result = await this.rpcHandler(message.method, message.path, message.body ?? undefined);
      reply(result.status, result.data);
    } catch (error) {
      reply(500, { error: (error as Error).message }, (error as Error).message);
    } finally {
      socket.data.activeRpcRequests = Math.max(0, (socket.data.activeRpcRequests ?? 1) - 1);
    }
  }

  // ---- Outbound request plumbing ----

  private requestSocket(socket: SocketLike, frame: Record<string, unknown> & { type: string }, timeoutMs: number): Promise<unknown> {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('P2P peer is not connected'));
    const id = `${this.peerId}-${(this.requestCounter += 1).toString(36)}-${Date.now().toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.connectionPending.get(socket)?.delete(id);
          reject(new Error('P2P request timed out'));
        }, timeoutMs),
      };
      let map = this.connectionPending.get(socket);
      if (!map) {
        map = new Map<string, PendingRequest>();
        this.connectionPending.set(socket, map);
      }
      map.set(id, pending);
      try {
        socket.send(JSON.stringify({ ...frame, id }));
      } catch (error) {
        map.delete(id);
        clearTimeout(pending.timer);
        reject(error as Error);
      }
    });
  }

  private resolveConnection(socket: SocketLike, message: PeerMessage & { id: string }): void {
    const pending = this.connectionPending.get(socket)?.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.connectionPending.get(socket)?.delete(message.id);
    pending.resolve(message);
  }

  private rejectConnection(socket: SocketLike, error: Error): void {
    const pending = this.connectionPending.get(socket);
    if (!pending) return;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  // ---- Active block synchronization ----

  private scheduleSyncTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.runSyncPass(), Math.max(0, delayMs));
  }

  private async runSyncPass(): Promise<void> {
    if (this.stopped || !this.dataSource || this.syncRunning) {
      if (!this.stopped) this.scheduleSyncTick(SYNC_INTERVAL_MS);
      return;
    }
    this.syncRunning = true;
    try {
      for (const socket of this.syncTargets()) {
        if (this.stopped) break;
        const last = this.lastSyncAt.get(socket) ?? 0;
        if (Date.now() - last < SYNC_PEER_COOLDOWN_MS) continue;
        this.lastSyncAt.set(socket, Date.now());
        try {
          await this.syncWithSocket(socket);
        } catch {
          // A failing peer must never stall the pass for the remaining peers.
        }
      }
    } finally {
      this.syncRunning = false;
      if (!this.stopped) this.scheduleSyncTick(SYNC_INTERVAL_MS);
    }
  }

  private syncTargets(): SocketLike[] {
    const targets: SocketLike[] = [];
    for (const peer of this.outbound.values()) {
      if (peer.fullNode && peer.socket?.readyState === WebSocket.OPEN) targets.push(peer.socket);
    }
    for (const socket of this.inbound) {
      if (socket.data.fullNode && socket.readyState === WebSocket.OPEN) targets.push(socket);
    }
    return targets;
  }

  private async syncWithSocket(socket: SocketLike): Promise<void> {
    const source = this.dataSource;
    if (!source) return;

    const tipResponse = await this.requestSocket(socket, { type: 'get_tip' }, 5_000);
    const peerTip = parseTipFrame(tipResponse);
    if (!peerTip) return;

    const local = source.status();
    const localWork = local.totalWork ? BigInt(local.totalWork) : (source.cumulativeWorkFrom(local.bestHash) ?? 0n);
    if (peerTip.height <= local.height) return;
    if (peerTip.totalWork !== '0' && BigInt(peerTip.totalWork) <= localWork) return;

    const sameAncestor = source.cumulativeWorkFrom(peerTip.bestHash) !== null;
    // Height where the peer chain starts to differ from the local best chain.
    // For a plain catch-up the peer extended our tip, so the first new block
    // sits at local height + 1. For a fork the candidate chain shares the
    // fork-point block and replaces everything above it; replaying from the
    // fork point lets consensus switch when the candidate carries more work.
    let fromHeight: number;
    if (sameAncestor) {
      fromHeight = local.height + 1;
    } else {
      const anchor = await this.locateForkAnchor(socket, source);
      if (anchor === null) return;
      fromHeight = anchor;
    }

    let fetched = 0;
    let requestHeight = fromHeight;
    while (!this.stopped) {
      if (requestHeight > peerTip.height || fetched >= MAX_BLOCKS_PER_SYNC_RUN) break;
      const response = await this.requestSocket(
        socket,
        { type: 'get_blocks', start: requestHeight, limit: BLOCKS_PAGE_SIZE },
        10_000,
      );
      const items = parseBlocksFrame(response);
      if (!items || items.length === 0) break;
      fetched += items.length;
      let advanced = false;
      for (const raw of items) {
        const block = deserializeBlock(raw);
        if (!block) break;
        // Blocks must arrive strictly in height order from the requested
        // height; a peer that skips or reorders blocks stops the download.
        if (block.header.height !== requestHeight) break;
        requestHeight += 1;
        advanced = true;
        // A fork replacement starts below the local tip: those blocks were
        // accepted earlier but may belong to the currently losing branch, so
        // they are fed to consensus again to drive the reorganization.
        this.onBlock?.(block);
      }
      if (!advanced) break;
    }
    this.fetchedBlocks += fetched;
  }

  /** Find the fork height where the local chain and the peer chain meet. */
  private async locateForkAnchor(socket: SocketLike, source: PeerDataSource): Promise<number | null> {
    const local = source.status();
    const step = Math.max(1, Math.ceil((local.height + 1) / LOCATE_MAX_HASHES));
    const samples: Array<{ height: number; hash: string }> = [];
    for (let height = local.height; height >= 0; height -= step) {
      const block = source.chainAtHeight(height);
      if (block) samples.push({ height, hash: block.hash });
    }
    if (samples.length === 0) return null;
    const last = samples[samples.length - 1]!;
    if (last.height !== 0) {
      const genesis = source.chainAtHeight(0);
      if (genesis) samples.push({ height: 0, hash: genesis.hash });
    }

    const firstIndex = await this.locateOnce(socket, samples.map((sample) => sample.hash));
    if (firstIndex === null) return null;
    if (firstIndex < 0) return null; // The peer shares no ancestor; do not fetch.
    // The peer knows samples[firstIndex] and nothing above it, so the fork
    // point is between this anchor and the next higher sample. When the anchor
    // is the local tip itself the peer simply extended our chain and the
    // download starts at the next height.
    const anchor = samples[firstIndex]!;
    const upper = firstIndex > 0 ? samples[firstIndex - 1]! : null;
    let refinedHeight = anchor.height;
    if (upper && upper.height - anchor.height > 1) {
      const gap = upper.height - anchor.height;
      const refineStep = Math.max(1, Math.ceil(gap / LOCATE_MAX_HASHES));
      const refineSamples: Array<{ height: number; hash: string }> = [];
      for (let height = upper.height - refineStep; height > anchor.height; height -= refineStep) {
        const block = source.chainAtHeight(height);
        if (block) refineSamples.push({ height, hash: block.hash });
      }
      if (refineSamples.length > 0) {
        const secondIndex = await this.locateOnce(socket, refineSamples.map((sample) => sample.hash));
        if (secondIndex !== null && secondIndex >= 0) {
          refinedHeight = refineSamples[secondIndex]!.height;
        } else if (secondIndex === -1) {
          refinedHeight = anchor.height;
        }
      }
    }
    return refinedHeight;
  }

  private async locateOnce(socket: SocketLike, hashes: string[]): Promise<number | null> {
    const response = await this.requestSocket(socket, { type: 'locate', hashes }, 5_000);
    const frame = response as Partial<{ type: string; index: unknown }> | null;
    if (typeof frame !== 'object' || frame === null || frame.type !== 'locate_result') return null;
    const index = typeof frame.index === 'number' && Number.isInteger(frame.index) ? frame.index : -1;
    return index;
  }
}

function parseTipFrame(value: unknown): { height: number; bestHash: string; totalWork: string } | null {
  const frame = value as Partial<{ type: string; height: unknown; bestHash: unknown; totalWork: unknown }> | null;
  if (typeof frame !== 'object' || frame === null || frame.type !== 'tip') return null;
  const height = Math.trunc(Number(frame.height));
  if (!Number.isSafeInteger(height) || height < 0 || typeof frame.bestHash !== 'string' || !/^[0-9a-f]{64}$/.test(frame.bestHash)) {
    return null;
  }
  const totalWork = typeof frame.totalWork === 'string' && /^[0-9]+$/.test(frame.totalWork) ? frame.totalWork : '0';
  return { height, bestHash: frame.bestHash, totalWork };
}

function parseBlocksFrame(value: unknown): unknown[] | null {
  const frame = value as Partial<{ type: string; items: unknown }> | null;
  if (typeof frame !== 'object' || frame === null || frame.type !== 'blocks' || !Array.isArray(frame.items)) return null;
  return frame.items;
}

function serializeBlock(block: Block): Record<string, unknown> {
  return {
    header: { ...block.header, difficulty: block.header.difficulty.toString() },
    hash: block.hash,
    nonce: block.nonce,
    coinbase: block.coinbase,
    transactions: block.transactions,
  };
}

/** Parse untrusted wire JSON into the BigInt-aware consensus block shape. */
function deserializeBlock(value: unknown): Block | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const header = raw.header as Record<string, unknown> | undefined;
  if (typeof header !== 'object' || header === null) return null;
  const difficultyRaw = header.difficulty;
  let difficulty: bigint;
  try {
    difficulty = typeof difficultyRaw === 'string' && /^[0-9]+$/.test(difficultyRaw)
      ? BigInt(difficultyRaw)
      : typeof difficultyRaw === 'bigint'
        ? difficultyRaw
        : BigInt(Number(difficultyRaw) || 0);
  } catch {
    return null;
  }
  const hash = typeof raw.hash === 'string' ? raw.hash : '';
  const nonce = Math.trunc(Number(raw.nonce));
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return {
    header: {
      version: Number(header.version),
      height: Math.trunc(Number(header.height)),
      previousHash: typeof header.previousHash === 'string' ? header.previousHash : '',
      timestampSeconds: Math.trunc(Number(header.timestampSeconds)),
      difficulty,
      merkleRoot: typeof header.merkleRoot === 'string' ? header.merkleRoot : '',
      powSeed: typeof header.powSeed === 'string' ? header.powSeed : '',
      payoutAddress: typeof header.payoutAddress === 'string' ? header.payoutAddress : '',
    },
    hash,
    nonce,
    coinbase: (raw.coinbase as Block['coinbase']) ?? null,
    transactions: Array.isArray(raw.transactions) ? (raw.transactions as Block['transactions']) : [],
  };
}

function fallbackNodeId(): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `anon-${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function reconnectDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(5, attempts - 1));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
}

function isValidNodeId(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizePeerUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
    const pathname = url.pathname.replace(/\/$/, '');
    if (pathname !== '' && pathname !== '/p2p') return undefined;
    if (url.search || url.hash) return undefined;
    url.pathname = '/p2p';
    url.search = '';
    url.hash = '';
    const normalized = url.toString().replace(/\/$/, '');
    return /^wss?:\/\/[\w.:\[\]-]+\/p2p$/i.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function parsePeerMessage(raw: string | ArrayBuffer | Uint8Array): PeerMessage | null {
  if (typeof raw !== 'string' || raw.length > 3_000_000) return null;
  try {
    const value = JSON.parse(raw) as PeerMessage;
    if (
      typeof value !== 'object' || value === null ||
      ![
        'hello', 'peers', 'transaction', 'block', 'rpc_request', 'rpc_result',
        'get_tip', 'tip', 'get_blocks', 'blocks', 'locate', 'locate_result',
      ].includes(value.type)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isValidRpcId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64;
}

function isValidRpcPath(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/') && path.length <= 2_048 && !path.includes('..');
}

function consumeRpcBudget(socket: ServerWebSocket<PeerState>): boolean {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - (socket.data.rpcRefilledAt ?? now)) / 1000);
  const tokens = Math.min(30, (socket.data.rpcTokens ?? 30) + elapsedSeconds * 10);
  if (tokens < 1) {
    socket.data.rpcTokens = tokens;
    socket.data.rpcRefilledAt = now;
    return false;
  }
  socket.data.rpcTokens = tokens - 1;
  socket.data.rpcRefilledAt = now;
  return true;
}
