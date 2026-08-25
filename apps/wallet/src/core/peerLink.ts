import { NETWORK_ID } from "@edgex/shared";
import type { SignedTransaction } from "@edgex/shared";

export interface PeerRpcResult {
  status: number;
  data: unknown;
}

export interface PeerLinkOptions {
  url: string;
  nodeId: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  onBlock?: (block: unknown) => void;
  onTransaction?: (transaction: SignedTransaction) => void;
}

interface PendingRequest {
  resolve: (result: PeerRpcResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One wallet-to-full-node WebSocket link with request/response semantics. */
export class PeerLink {
  readonly url: string;
  connected = false;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private readonly options: PeerLinkOptions) {
    this.url = normalizeP2PUrl(options.url);
  }

  async info(): Promise<unknown> {
    const result = await this.request<Record<string, unknown>>("GET", "/chain/info");
    return result;
  }

  async request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    await this.open();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`P2P link is not open: ${this.url}`);
    }
    const id = `${Date.now()}-${this.nextId++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`P2P request timed out: ${this.url}${path}`));
      }, this.options.requestTimeoutMs ?? 10_000);
      this.pending.set(id, {
        resolve: (result) => {
          if (result.status >= 200 && result.status < 300) resolve(result.data as T);
          else {
            const detail = (result.data as { error?: string } | null)?.error;
            reject(new Error(detail ?? `P2P node returned HTTP ${result.status}`));
          }
        },
        reject,
        timer,
      });
      try {
        this.socket!.send(JSON.stringify({
          type: "rpc_request",
          id,
          method,
          path,
          ...(body === undefined ? {} : { body }),
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  open(): Promise<void> {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error(`P2P connection timed out: ${this.url}`));
      }, this.options.connectTimeoutMs ?? 3_000);

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          nodeId: this.options.nodeId,
          networkId: NETWORK_ID,
          height: 0,
          bestHash: "",
        }));
      });
      socket.addEventListener("message", (event) => {
        const value = parseMessage(event.data);
        if (!value) return;
        if (value.type === "hello") {
          if (value.networkId !== NETWORK_ID) {
            socket.close();
            return;
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.socket = socket;
            this.connected = true;
            resolve();
          }
          return;
        }
        if (value.type === "block") this.options.onBlock?.(value.block);
        if (value.type === "transaction") this.options.onTransaction?.(value.transaction);
        if (value.type !== "rpc_result") return;
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        pending.resolve({ status: value.status, data: value.data });
      });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`P2P connection failed: ${this.url}`));
      });
      socket.addEventListener("close", () => {
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`P2P link disconnected: ${this.url}`));
        }
        this.pending.clear();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close(): void {
    this.connected = false;
    this.socket?.close();
    this.socket = null;
  }
}

function normalizeP2PUrl(value: string): string {
  const url = new URL(/^wss?:\/\//i.test(value) ? value : `ws://${value}`);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/p2p";
  return url.toString().replace(/\/$/, "");
}

type PeerWireMessage =
  | { type: "hello"; networkId: string }
  | { type: "block"; block: unknown }
  | { type: "transaction"; transaction: SignedTransaction }
  | { type: "rpc_result"; id: string; status: number; data?: unknown };

function parseMessage(raw: unknown): PeerWireMessage | null {
  try {
    const value = JSON.parse(String(raw)) as PeerWireMessage;
    if (typeof value !== "object" || value === null || typeof value.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}
