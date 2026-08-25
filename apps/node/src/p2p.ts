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
  | { type: 'hello'; nodeId: string; networkId: string; height: number; bestHash: string }
  | { type: 'transaction'; transaction: SignedTransaction }
  | { type: 'block'; block: Block }
  | { type: 'rpc_request'; id: string; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { type: 'rpc_result'; id: string; status: number; data?: unknown; error?: string };

interface PeerState {
  nodeId?: string;
  networkId?: string;
  rpcTokens?: number;
  rpcRefilledAt?: number;
  activeRpcRequests?: number;
}

interface PendingRpc {
  resolve: (result: { status: number; data: unknown }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Small authenticated-by-consensus gossip surface; peers gain trust only through valid blocks. */
export class P2PNetwork {
  private readonly peers = new Set<ServerWebSocket<PeerState>>();
  private readonly outboundPeers = new Set<WebSocket>();
  private server?: ReturnType<typeof Bun.serve<PeerState>>;
  private rpcHandler?: P2PRpcHandler | undefined;
  private readonly outboundPending = new WeakMap<WebSocket, Map<string, PendingRpc>>();

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
  ) {}

  start(seeds: readonly string[]): void {
    this.server = Bun.serve<PeerState>({
      port: this.port,
      fetch: (request, server) => {
        if (server.upgrade(request, { data: {} })) return undefined;
        return new Response('EdgeX WebSocket endpoint', { status: 426 });
      },
      websocket: {
        open: (socket) => {
          socket.data = {};
          this.peers.add(socket);
          socket.send(JSON.stringify(this.hello()));
        },
        message: (socket, message) => this.handle(socket, message),
        close: (socket) => {
          this.peers.delete(socket);
        },
      },
    });

    for (const seed of seeds.slice(0, 16)) void this.connect(seed);
  }

  async connect(url: string): Promise<void> {
    if (!/^wss?:\/\//.test(url) || this.peerCount > 128) return;
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      this.outboundPeers.add(socket);
      socket.send(JSON.stringify(this.hello()));
    });
    socket.addEventListener('close', () => this.outboundPeers.delete(socket));
    socket.addEventListener('message', (event) => {
      handleMessage(event.data as string, (message: PeerMessage) => {
        if (message.type === 'transaction') this.onTransaction(message.transaction);
        if (message.type === 'block') this.onBlock(message.block);
        if (message.type === 'rpc_result') this.resolveOutbound(socket, message);
      });
    });
  }

  broadcast(message: PeerMessage): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers) peer.send(payload);
    for (const peer of this.outboundPeers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(payload);
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get boundPort(): number | undefined {
    return this.server?.port;
  }

  stop(): void {
    this.server?.stop(true);
    this.peers.clear();
    this.outboundPeers.clear();
  }

  private hello(): PeerMessage {
    return {
      type: 'hello',
      nodeId: this.nodeId,
      networkId: NETWORK_ID,
      height: this.status().height,
      bestHash: this.status().bestHash,
    };
  }

  private handle(socket: ServerWebSocket<PeerState>, raw: string | ArrayBuffer | Uint8Array): void {
    if (typeof raw !== 'string') return;
    handleMessage(raw, (message: PeerMessage) => {
      if (message.type === 'hello') {
        if (message.networkId !== NETWORK_ID || !/^[\w:-]{8,80}$/.test(message.nodeId)) {
          socket.close();
          return;
        }
        socket.data.nodeId = message.nodeId;
        socket.data.networkId = message.networkId;
      }
      if (message.type === 'transaction') this.onTransaction(message.transaction);
      if (message.type === 'block') this.onBlock(message.block);
      if (message.type === 'rpc_request') void this.handleRpcRequest(socket, message);
    });
  }

  private async handleRpcRequest(
    socket: ServerWebSocket<PeerState>,
    message: Extract<PeerMessage, { type: 'rpc_request' }>,
  ): Promise<void> {
    const reply = (status: number, data: unknown, error?: string) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'rpc_result', id: message.id, status, data, ...(error ? { error } : {}) }));
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
}

function handleMessage(raw: string, handler: (message: PeerMessage) => void): void {
  if (raw.length > 3_000_000) return;
  try {
    const value = JSON.parse(raw) as PeerMessage;
    if (value.type !== 'hello' && value.type !== 'transaction' && value.type !== 'block' &&
        value.type !== 'rpc_request' && value.type !== 'rpc_result') return;
    handler(value);
  } catch {
    // Malformed gossip is silently discarded after rate limiting at the transport layer.
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
