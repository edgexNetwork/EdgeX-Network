import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PeerView } from "../api/types";
import type { Logger } from "../utils/log";
import { PeerLink } from "./peerLink";

export interface ConnectionManagerOptions {
  nodeUrl: string;
  configuredNodes: readonly string[];
  log: Logger;
  nodeId?: string | undefined;
  peerStoreFile?: string | undefined;
  onBlock?: ((block: unknown) => void) | undefined;
  onTransaction?: ((transaction: unknown) => void) | undefined;
}

interface NormalizedPeer {
  address: string;
  httpUrl?: string;
  wsUrls: string[];
}

interface PeerState {
  view: PeerView;
  httpUrl?: string;
  links: PeerLink[];
}

export interface TransportResult {
  status: number;
  data: unknown;
}

function normalizePeer(value: string): NormalizedPeer {
  const input = value.trim();
  if (input === "") throw new Error("empty node address");
  if (/^wss?:\/\//i.test(input)) {
    return { address: input.replace(/\/$/, ""), wsUrls: [input] };
  }
  const base = /^https?:\/\//i.test(input) ? input : `http://${input}`;
  const http = new URL(base);
  http.pathname = "";
  http.search = "";
  http.hash = "";
  const wsUrls: string[] = [];
  const port = Number.parseInt(http.port, 10);
  const protocol = http.protocol === "https:" ? "wss:" : "ws:";
  const makeUrl = (targetPort: number) => {
    const url = new URL(`${protocol}//${http.hostname}:${targetPort}/p2p`);
    return url.toString().replace(/\/$/, "");
  };
  if (Number.isInteger(port) && port > 0 && port < 65535 && port + 1 <= 65535) wsUrls.push(makeUrl(port + 1));
  else wsUrls.push(`${protocol}//${http.hostname}${http.port ? `:${http.port}` : ""}/p2p`);
  // Some deployments expose RPC and P2P upgrade on the same HTTP origin.
  wsUrls.push(`${protocol}//${http.host}/p2p`);
  return { address: http.toString().replace(/\/$/, ""), httpUrl: http.toString().replace(/\/$/, ""), wsUrls: [...new Set(wsUrls)] };
}

function dedupeKey(peer: NormalizedPeer): string {
  return peer.wsUrls[0] ?? peer.address;
}

/** Wallet-side full-node links. Requests try direct RPC first and P2P WebSocket second. */
export class ConnectionManager {
  private readonly states = new Map<string, PeerState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextPeerId = 1;
  connectedCount = 0;

  constructor(private readonly options: ConnectionManagerOptions) {
    const configured: string[] = [options.nodeUrl, ...options.configuredNodes];
    for (const address of configured) this.addState(address, "config");
    if (options.peerStoreFile) this.loadPersisted();
  }

  start(): void {
    if (this.timer) return;
    void this.refreshConnection();
    this.timer = setInterval(() => void this.refreshConnection(), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.states.values()) for (const link of state.links) link.close();
  }

  addNode(address: string): PeerView {
    const normalized = normalizePeer(address);
    const key = dedupeKey(normalized);
    let state = this.states.get(key);
    if (!state) state = this.addState(address, "runtime");
    this.persistRuntimePeers();
    void this.probePeer(state);
    return state.view;
  }

  /** Removes a runtime-added node (bitcoind addnode "remove"): closes its links and forgets it. */
  removeNode(address: string): boolean {
    const normalized = normalizePeer(address);
    const key = dedupeKey(normalized);
    const state = this.states.get(key);
    if (!state) return false;
    for (const link of state.links) link.close();
    this.states.delete(key);
    this.recount();
    this.persistRuntimePeers();
    return true;
  }

  async refreshConnection(): Promise<boolean> {
    const results = await Promise.all([...this.states.values()].map((state) => this.probePeer(state)));
    this.connectedCount = results.filter(Boolean).length;
    return this.connectedCount > 0;
  }

  async requestTransport(method: "GET" | "POST", path: string, body?: unknown): Promise<TransportResult> {
    const ordered = [...this.states.values()].sort(
      (left, right) => Number(right.view.connected) - Number(left.view.connected),
    );
    let lastError: unknown;
    for (const state of ordered) {
      try {
        return await this.requestFromState(state, method, path, body);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `No reachable EdgeX node (${this.options.nodeUrl}): ${(lastError as Error)?.message ?? "unknown error"}`,
    );
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const result = await this.requestTransport(method, path, body);
    if (result.status < 200 || result.status >= 300) {
      const detail = (result.data as { error?: string } | null)?.error;
      throw new Error(detail ?? `node returned HTTP ${result.status}`);
    }
    return result.data as T;
  }

  snapshot(): PeerView[] {
    return [...this.states.values()].map((state) => state.view).sort((left, right) => left.id - right.id);
  }

  selfPublicUrl(): string {
    return "";
  }

  private addState(address: string, source: PeerView["source"]): PeerState {
    const normalized = normalizePeer(address);
    const key = dedupeKey(normalized);
    const existing = this.states.get(key);
    if (existing) return existing;
    const nodeId = `${this.options.nodeId ?? "wallet"}-${key}`;
    const links = normalized.wsUrls.map((url) => new PeerLink({
      url,
      nodeId,
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 10_000,
      onBlock: this.options.onBlock,
      onTransaction: this.options.onTransaction as never,
    }));
    const state: PeerState = {
      view: { id: this.nextPeerId++, addr: normalized.address, connected: false, latencyMs: null, source },
      httpUrl: normalized.httpUrl,
      links,
    };
    this.states.set(key, state);
    return state;
  }

  private async probePeer(state: PeerState): Promise<boolean> {
    const startedAt = performance.now();
    if (state.httpUrl) {
      try {
        const response = await fetch(new URL("/chain/info", state.httpUrl), { signal: AbortSignal.timeout(2_000) });
        await response.json();
        markConnected(state, startedAt);
        return true;
      } catch {
        // Fall through to the peer links.
      }
    }
    for (const link of state.links) {
      try {
        await link.open();
        await link.info();
        markConnected(state, startedAt);
        return true;
      } catch {
        link.close();
        state.view.connected = false;
      }
    }
    state.view.connected = false;
    state.view.latencyMs = null;
    this.recount();
    return false;
  }

  private async requestFromState(
    state: PeerState,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportResult> {
    if (state.httpUrl) {
      try {
        const response = await fetch(new URL(path, state.httpUrl), {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await response.json().catch(() => null);
        markConnected(state, performance.now());
        return { status: response.status, data };
      } catch (error) {
        state.view.connected = false;
        lastErrorStore.set(this, error);
      }
    }
    for (const link of state.links) {
      try {
        // The peer link unwraps successful responses to their payload (a
        // non-2xx status rejects instead of returning an envelope), so the
        // payload is repacked into the transport result shape here.
        const payload = await link.request<unknown>(method, path, body);
        state.view.connected = true;
        return { status: 200, data: payload };
      } catch (error) {
        state.view.connected = false;
        lastErrorStore.set(this, error);
      }
    }
    throw lastErrorStore.get(this) ?? new Error("peer is unreachable");
  }

  private loadPersisted(): void {
    const file = this.options.peerStoreFile;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { runtime?: unknown };
      if (!Array.isArray(raw.runtime)) return;
      for (const item of raw.runtime.slice(0, 64)) {
        if (typeof item === "string") this.addState(item, "runtime");
      }
    } catch (error) {
      this.options.log.warn(`Failed to load persisted peers: ${(error as Error).message}`);
    }
  }

  private persistRuntimePeers(): void {
    const file = this.options.peerStoreFile;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const runtime = [...this.states.values()]
        .filter((state) => state.view.source === "runtime")
        .map((state) => state.view.addr);
      writeFileSync(file, JSON.stringify({ runtime }, null, 2), { mode: 0o600 });
    } catch (error) {
      this.options.log.warn(`Failed to persist peers: ${(error as Error).message}`);
    }
  }

  private recount(): void {
    this.connectedCount = [...this.states.values()].filter((state) => state.view.connected).length;
  }
}

const lastErrorStore = new WeakMap<ConnectionManager, unknown>();

function markConnected(state: PeerState, startedAt: number): void {
  state.view.connected = true;
  state.view.latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
}
