import type { SignedTransaction } from '@edgex/shared';
import { STRATUM_ALGORITHM, validateAddress } from '@edgex/shared';
import { formatEdxAmount } from '@edgex/shared';
import type { Block } from '@edgex/core';
import type { ChainService } from './service';

export interface RpcServerOptions {
  host: string;
  port: number;
  service: ChainService;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Parse untrusted wire JSON into the BigInt-aware consensus block shape. */
function parseBlock(value: unknown): Block {
  if (typeof value !== 'object' || value === null) throw new Error('block must be an object');
  const raw = value as Block & { header: { difficulty: bigint | number | string } };
  const difficulty = typeof raw.header?.difficulty === 'string'
    ? BigInt(raw.header.difficulty)
    : BigInt(raw.header?.difficulty ?? 0);
  return { ...raw, nonce: Number(raw.nonce), header: { ...raw.header, difficulty } };
}

export class RpcServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: RpcServerOptions) {}

  start(): void {
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      fetch: async (request) => this.handle(request),
    });
  }

  stop(): void {
    this.server?.stop(true);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
      if (request.method === 'GET' && url.pathname === '/chain/info') return json(this.options.service.info());
      if (request.method === 'GET' && url.pathname === '/chain/tip') {
        return json(this.options.service.chain.get(this.options.service.chain.bestBlockHash).block);
      }
      if (request.method === 'GET' && url.pathname === '/chain/blocks') {
        const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        return json({ items: this.options.service.canonicalBlocks(start, limit) });
      }
      if (request.method === 'GET' && url.pathname === '/wallet/utxos') {
        const address = url.searchParams.get('address') ?? '';
        if (!validateAddress(address)) return error('invalid address');
        const state = this.options.service.chain.stateAt(this.options.service.chain.bestBlockHash);
        return json({
          items: state.all(address).map((entry) => ({
            txid: entry.txid,
            index: entry.index,
            address: entry.address,
            amount: formatEdxAmount(entry.amountPhotons),
            birthHeight: entry.birthHeight,
            isCoinbase: entry.isCoinbase,
            spendable: !entry.isCoinbase || this.options.service.chain.height >= entry.birthHeight + 6,
          })),
        });
      }
      if (request.method === 'GET' && url.pathname === '/wallet/history') {
        const address = url.searchParams.get('address') ?? '';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        return json(this.options.service.history(address, limit));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/transactions/')) {
        const txid = decodeURIComponent(url.pathname.slice('/transactions/'.length));
        return json(this.options.service.findTransaction(txid));
      }
      if (request.method === 'GET' && url.pathname === '/peers') {
        return json(this.options.service.peers());
      }

      if (request.method !== 'POST') return error('not found', 404);
      const raw = await request.text();
      if (raw.length > 3_000_000) return error('payload too large', 413);
      const body = JSON.parse(raw) as Record<string, unknown>;

      if (url.pathname === '/transactions') {
        const id = this.options.service.acceptTransaction(body as unknown as SignedTransaction);
        return json({ accepted: true, txid: id });
      }
      if (url.pathname === '/blocks') {
        const block = parseBlock(body);
        const result = this.options.service.acceptBlock(block);
        return json({ result });
      }
      if (url.pathname === '/mining/template') {
        const address = String(body.address ?? '');
        if (!validateAddress(address)) return error('invalid payout address');
        const job = this.options.service.createJob(address);
        return json({
          algorithm: STRATUM_ALGORITHM,
          jobId: job.jobId,
          blobHex: job.blobHex,
          seedHash: job.seedHash,
          targetHex: job.targetHex,
          height: job.height,
          difficulty: job.difficulty.toString(),
          block: job.block,
        });
      }
      if (url.pathname === '/mining/submit') {
        const jobId = String(body.jobId ?? '');
        const nonce = String(body.nonce ?? '');
        const hash = String(body.hash ?? '');
        return json(this.options.service.submitShare(jobId, nonce, hash));
      }
      return error('not found', 404);
    } catch (caught) {
      return error((caught as Error).message || 'invalid request');
    }
  }
}
