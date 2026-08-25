import type { ServerWebSocket } from 'bun';
import { NETWORK_ID } from '@edgex/shared';
import type { Block } from '@edgex/core';
import type { SignedTransaction } from '@edgex/shared';

export type P2PRpcHandler = (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
) => Promise<{ status: number; data: unknown }>;

type PeerMessage =
  | { type: 'hello'; nodeId: string; networkId: string; height: number; bestHash: string; advertisedUrl?: string }
  | { type: 'peers'; peers: unknown }
  | { type: 'transaction'; transaction: SignedTransaction }
  | { type: 'block'; block: Block }
  | { type: 'rpc_request'; id: string; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { type: 'rpc_result'; id: string; status: number; data?: unknown; error?: string };

interface PeerState {
  nodeId?: string;
  networkId?: string;
  advertisedUrl?: string;
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
}

interface PendingRpc {
  resolve: (result: { status: number; data: unknown }) => void;
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

/** Consensus-authenticated gossip surface; peer trust comes only from valid blocks. */
export class P2PNetwork {
  private readonly inbound = new Set<ServerWebSocket<PeerState>>();
  private readonly outbound = new Map<string, OutboundPeer>();
  private readonly outboundSocketEntries = new WeakMap<WebSocket, OutboundPeer>();
  private readonly outboundPending = new WeakMap<WebSocket, Map<string, PendingRpc>>();
  private server?: ReturnType<typeof Bun.serve<PeerState>>;
  private rpcHandler?: P2PRpcHandler | undefined;
  private stopped = false;
  private selfUrl: string | undefined;

  /** Install the loopback-equivalent public API handler used by wallet peers. */
  setRpcHandler(handler: P2PRpcHandler): void {
    this.rpcHandler = handler;
  }

  constructor(
    private readonly port: number,
    private readonly nodeId: string,
    private readonly status: () => { height: number; bestHash: string },
    private readonly onTransaction: (transaction: SignedTransaction) => void,
    private readonly onBlock: (block: Block) => void,
    private readonly publicUrl?: string | undefined,
    private readonly webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {
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
        },
      },
    });

    for (const seed of seeds.slice(0, MAX_PEERS)) this.connect(seed);
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
    for (const peer of this.outbound.values()) {
      if (peer.timer) clearTimeout(peer.timer);
      peer.timer = undefined;
      peer.socket?.close();
    }
    for (const socket of this.inbound) socket.close();
    this.outbound.clear();
    this.inbound.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  private hello(): PeerMessage {
    return {
      type: 'hello',
      nodeId: this.nodeId,
      networkId: NETWORK_ID,
      height: this.status().height,
      bestHash: this.status().bestHash,
      ...(this.selfUrl ? { advertisedUrl: this.selfUrl } : {}),
    };
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
    this.outboundSocketEntries.set(socket, peer);

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
      this.rejectPending(socket, new Error(`P2P peer disconnected: ${peer.url}`));
      if (peer.socket !== socket && this.outboundSocketEntries.get(socket) !== peer) return;
      peer.socket = undefined;
      peer.advertisedUrl = undefined;
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
      else socket.send(JSON.stringify({
        type: 'peers',
        peers: this.knownPeerUrls(message.advertisedUrl),
      }));
      return;
    }
    if (message.type === 'peers') {
      this.addDiscoveredPeers(message.peers);
      return;
    }
    if (message.type === 'rpc_request') void this.handleRpcRequest(socket, message);
    else this.handleCommonMessage(message);
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
    if (message.type === 'rpc_result') {
      this.resolveOutbound(socket, message);
      return;
    }
    this.handleCommonMessage(message);
  }

  private acceptHello(
    socket: WebSocket | ServerWebSocket<PeerState>,
    message: Extract<PeerMessage, { type: 'hello' }>,
    outboundPeer?: OutboundPeer,
  ): boolean {
    if (message.networkId !== NETWORK_ID || !/^[\w:-]{8,80}$/.test(message.nodeId)) return false;
    const advertisedUrl = normalizePeerUrl(message.advertisedUrl ?? '');
    if (message.advertisedUrl && !advertisedUrl) return false;

    if (outboundPeer) {
      outboundPeer.advertisedUrl = advertisedUrl || undefined;
    } else {
      const inbound = socket as ServerWebSocket<PeerState>;
      inbound.data.nodeId = message.nodeId;
      inbound.data.networkId = message.networkId;
      inbound.data.advertisedUrl = advertisedUrl || undefined;
    }

    socket.send(JSON.stringify({
      type: 'peers',
      peers: this.knownPeerUrls(outboundPeer ? outboundPeer.url : advertisedUrl),
    }));
    return true;
  }

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

  private handleCommonMessage(message: PeerMessage): void {
    if (message.type === 'transaction') this.onTransaction(message.transaction);
    if (message.type === 'block') this.onBlock(message.block);
  }

  private addDiscoveredPeers(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value.slice(0, MAX_PEER_ANNOUNCEMENTS)) {
      if (typeof item === 'string') this.connect(item);
    }
  }

  private forgetPeer(peer: OutboundPeer, socket: WebSocket): void {
    peer.timer = undefined;
    peer.socket = undefined;
    if (this.outbound.get(peer.url) === peer) this.outbound.delete(peer.url);
    this.rejectPending(socket, new Error('invalid P2P handshake'));
    socket.close();
  }

  private resolveOutbound(
    socket: WebSocket,
    message: Extract<PeerMessage, { type: 'rpc_result' }>,
  ): void {
    const pending = this.outboundPending.get(socket)?.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.outboundPending.get(socket)?.delete(message.id);
    if (typeof message.status === 'number') pending.resolve({ status: message.status, data: message.data });
    else pending.reject(new Error(message.error ?? 'invalid P2P RPC response'));
  }

  private rejectPending(socket: WebSocket, error: Error): void {
    const pending = this.outboundPending.get(socket);
    if (!pending) return;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
}

export function reconnectDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(5, attempts - 1));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
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
      !['hello', 'peers', 'transaction', 'block', 'rpc_request', 'rpc_result'].includes(value.type)
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
