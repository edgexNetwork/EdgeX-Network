import type { SignedTransaction } from '@edgex/shared';
import type { PeerView, TxView, UtxoDTO } from './api/types';

export interface NodeRpcClientOptions {
  baseUrl: string;
  timeoutMs?: number | undefined;
}

export class NodeRpcClient {
  readonly baseUrl: string;

  constructor(private readonly options: NodeRpcClientOptions) {
    this.baseUrl = options.baseUrl;
  }

  async info(): Promise<Record<string, unknown>> {
    return this.request('GET', '/chain/info');
  }

  async utxos(address: string): Promise<UtxoDTO[]> {
    const result = await this.request<{ items: UtxoDTO[] }>('GET', `/wallet/utxos?address=${encodeURIComponent(address)}`);
    return result.items;
  }

  async history(address: string, limit = 20): Promise<TxView[]> {
    return this.request('GET', `/wallet/history?address=${encodeURIComponent(address)}&limit=${limit}`);
  }

  async transaction(txid: string): Promise<TxView | null> {
    return this.request('GET', `/transactions/${encodeURIComponent(txid)}`);
  }

  async peers(): Promise<{ connected: number; total: number; items: PeerView[] }> {
    return this.request('GET', '/peers');
  }

  async blocks(startHeight: number, limit = 200): Promise<unknown[]> {
    const result = await this.request<{ items: unknown[] }>('GET', `/chain/blocks?start=${startHeight}&limit=${limit}`);
    return result.items;
  }

  async submitTransaction(transaction: SignedTransaction): Promise<string> {
    const result = await this.request<{ txid: string }>('POST', '/transactions', transaction);
    return result.txid;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const data = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `node request failed with HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
