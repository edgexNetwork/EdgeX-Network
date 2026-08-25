import { STRATUM_ALGORITHM, formatEdxAmount, validateAddress } from '@edgex/shared';
import type { ChainService, MiningJob } from './service';

interface StratumSocketData {
  buffer: string;
  payoutAddress?: string;
  worker?: string;
}

interface TcpSocket {
  data: StratumSocketData;
  write(data: string): number;
  end(): void;
}

/** Monero-style Stratum bridge backed exclusively by locally validated chain jobs. */
export class StratumServer {
  private listener?: { stop(closeActive?: boolean): void };
  private readonly sockets = new Set<TcpSocket>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly service: ChainService,
  ) {}

  start(): void {
    this.listener = Bun.listen<StratumSocketData>({
      hostname: this.host,
      port: this.port,
      socket: {
        open: (socket) => {
          socket.data.buffer = '';
          this.sockets.add(socket as TcpSocket);
          return;
        },
        data: (socket, chunk) => {
          socket.data.buffer += chunk.toString('utf8');
          let boundary = socket.data.buffer.indexOf('\n');
          while (boundary >= 0) {
            const line = socket.data.buffer.slice(0, boundary).trim();
            socket.data.buffer = socket.data.buffer.slice(boundary + 1);
            if (line) this.handleLine(socket as TcpSocket, line);
            boundary = socket.data.buffer.indexOf('\n');
          }
          if (socket.data.buffer.length > 64_000) socket.end();
        },
        close: (socket) => {
          this.sockets.delete(socket as TcpSocket);
        },
        error: (socket) => {
          this.sockets.delete(socket as TcpSocket);
        },
      },
    });
  }

  /** Refresh every authorized miner when consensus advances. */
  notifyNewTip(): void {
    for (const socket of this.sockets) {
      if (!socket.data.payoutAddress) continue;
      this.sendJob(socket, socket.data.payoutAddress);
    }
  }

  stop(): void {
    for (const socket of this.sockets) socket.end();
    this.sockets.clear();
    this.listener?.stop(true);
  }

  private handleLine(socket: TcpSocket, line: string): void {
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    const params = Array.isArray(request.params) ? request.params : [];
    try {
      switch (request.method) {
        case 'mining.subscribe':
          this.reply(socket, id, [
            [['mining.set_difficulty', 'edgex'], ['mining.notify', 'edgex']],
            'edgex-session',
            STRATUM_ALGORITHM,
          ]);
          break;
        case 'mining.authorize': {
          const worker = String(params[0] ?? 'anonymous');
          const address = worker.split('.')[0]!;
          if (!validateAddress(address)) throw new Error('payout is not a valid EDX address');
          socket.data.worker = worker;
          socket.data.payoutAddress = address;
          this.reply(socket, id, true);
          this.sendJob(socket, address);
          break;
        }
        case 'mining.submit': {
          const jobId = String(params[1] ?? '');
          const nonce = String(params[2] ?? '');
          const hash = String(params[3] ?? '');
          this.service.submitShare(jobId, nonce, hash.toLowerCase());
          this.reply(socket, id, true);
          break;
        }
        case 'mining.get_job': {
          const address = String(params[0] ?? '').split('.')[0] ?? '';
          if (!validateAddress(address)) throw new Error('payout is not a valid EDX address');
          socket.data.payoutAddress = address;
          this.sendJob(socket, address);
          break;
        }
        default:
          this.error(socket, id, 'unsupported Stratum method');
      }
    } catch (caught) {
      this.error(socket, id, (caught as Error).message);
    }
  }

  private sendJob(socket: TcpSocket, payoutAddress: string): void {
    const job = this.service.createJob(payoutAddress);
    this.notify(socket, 'mining.notify', [
      job.jobId,
      job.blobHex,
      job.seedHash,
      job.targetHex,
      true,
      job.height,
      '',
    ]);
    this.notify(socket, 'mining.set_difficulty', [Number(job.difficulty)]);
  }

  private reply(socket: TcpSocket, id: unknown, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: null, result })}\n`);
  }

  private error(socket: TcpSocket, id: unknown, message: string): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message }, result: null })}\n`);
  }

  private notify(socket: TcpSocket, method: string, params: unknown[]): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

// Preserve emission display precision without putting formatted values in consensus.
export function formatRewardForLog(amountPhotons: bigint): string {
  return `${formatEdxAmount(amountPhotons)} EDX`;
}
