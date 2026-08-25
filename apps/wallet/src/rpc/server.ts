import { createHash, timingSafeEqual } from "node:crypto";
import type { WalletCore } from "../core/walletCore";
import type { TxView } from "../api/types";
import type { Logger } from "../utils/log";
import type { WalletConfig } from "../config/config";

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function response(id: unknown, result?: unknown, error?: { code: number; message: string }, status = 200): Response {
  const body = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function transactionDto(tx: TxView) {
  return {
    txid: tx.txid,
    type: tx.type,
    from: tx.from,
    inputs: tx.inputs,
    outputs: tx.outputs,
    fee: tx.fee,
    status: tx.status,
    blockHeight: tx.height,
    confirmations: tx.confirmations,
    createdAt: new Date(tx.time * 1000).toISOString(),
  };
}

/** Local bitcoind-style JSON-RPC compatibility surface for the decentralized wallet core. */
export class WalletRpcServer {
  private server?: ReturnType<typeof Bun.serve>;
  private miningRunning = false;

  constructor(
    private readonly config: WalletConfig,
    private readonly core: WalletCore,
    private readonly log: Logger,
  ) {}

  get listening(): boolean {
    return this.server !== undefined;
  }

  start(): void {
    if (!this.config.rpcuser || !this.config.rpcpassword) {
      this.log.warn("rpcuser/rpcpassword not configured; wallet RPC server not started");
      return;
    }
    if (this.config.rpcport === undefined) {
      this.log.warn("rpcport not configured; wallet RPC server not started");
      return;
    }
    try {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port: this.config.rpcport,
        fetch: (request) => this.handle(request),
      });
      this.log.info(`Wallet RPC server started: http://127.0.0.1:${this.config.rpcport}`);
    } catch (error) {
      throw new Error(`Cannot bind wallet RPC port ${this.config.rpcport}: ${(error as Error).message}`);
    }
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return response(null, undefined, { code: RPC_INVALID_PARAMS, message: "only POST allowed" }, 405);
    }
    if (!this.authorized(request)) return new Response("Unauthorized", { status: 401 });
    let payload: JsonRpcRequest;
    try {
      payload = await request.json() as JsonRpcRequest;
    } catch {
      return response(null, undefined, { code: RPC_PARSE_ERROR, message: "parse error" }, 400);
    }
    if (typeof payload.method !== "string") {
      return response(payload.id ?? null, undefined, { code: RPC_INVALID_REQUEST, message: "invalid request" });
    }
    const params = Array.isArray(payload.params) ? payload.params : [];
    try {
      const result = await this.dispatch(payload.method, params);
      return response(payload.id ?? null, result);
    } catch (error) {
      const message = (error as Error).message || "internal error";
      const code = (error as { code?: number }).code ?? RPC_INTERNAL_ERROR;
      return response(payload.id ?? null, undefined, { code, message });
    }
  }

  private authorized(request: Request): boolean {
    const header = request.headers.get("authorization") ?? "";
    const expected = `Basic ${Buffer.from(`${this.config.rpcuser}:${this.config.rpcpassword}`).toString("base64")}`;
    return timingSafeEqual(createHash("sha256").update(header).digest(), createHash("sha256").update(expected).digest());
  }

  private requireParams(params: unknown[], minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
    if (params.length < minimum || params.length > maximum) {
      const error = new Error(`Invalid parameter count: expected ${minimum}-${maximum}, got ${params.length}`);
      (error as { code?: number }).code = RPC_INVALID_PARAMS;
      throw error;
    }
  }

  private async dispatch(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "getblockchaininfo": {
        const info = await this.core.getChainInfo();
        return {
          chain: "edx",
          blocks: info.blocks,
          backendHeight: info.backendHeight,
          syncPercent: info.syncProgress,
          connection: info.connectedNodes > 0 ? "connected" : "disconnected",
          phase: info.phase,
          rewardPerBlock: info.blockReward,
          networkPower: info.networkPower,
        };
      }
      case "getblockcount":
        return this.core.getBlockCount();
      case "getbalance":
        return this.core.getBalance();
      case "getnewaddress":
        return this.core.getAddress();
      case "sendtoaddress": {
        this.requireParams(params, 2, 4);
        const [to, amount, fee, password] = params;
        if (typeof to !== "string" || typeof amount !== "string") {
          throw parameterError("sendtoaddress parameter error: <address> <amount> [fee] [password]");
        }
        return this.core.send([{ address: to, amount }], {
          explicitFee: typeof fee === "string" ? fee : null,
        }, typeof password === "string" ? password : undefined);
      }
      case "gettransaction": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("gettransaction requires a txid");
        const transaction = await this.core.getTransaction(params[0]);
        return transaction ? transactionDto(transaction) : null;
      }
      case "listtransactions": {
        this.requireParams(params, 0, 1);
        const count = typeof params[0] === "number" ? Math.floor(params[0]) : 20;
        return (await this.core.listTransactions(count)).map(transactionDto);
      }
      case "estimatesmartfee": {
        const fees = await this.core.getFees(true);
        return { slow: fees.slow, normal: fees.normal, fast: fees.fast, recommended: fees.recommended };
      }
      case "getpeerinfo":
        return this.core.getPeers().map((peer) => ({
          address: peer.addr,
          connected: peer.connected,
          latencyMs: peer.latencyMs,
        }));
      case "getconnectioncount":
        return this.core.getConnectionCount();
      case "getmininginfo": {
        const info = await this.core.getChainInfo();
        const mining = await this.core.getMiningInfo();
        return {
          blocks: info.blocks,
          difficulty: mining.difficulty,
          networkhashps: mining.networkHashps,
          pooledtx: info.pendingCount,
          chain: "edx",
        };
      }
      case "getnetworkhashps":
        return (await this.core.getMiningInfo()).networkHashps;
      case "getminingjob":
        return this.core.getMiningJob();
      case "getminingstats": {
        const mining = await this.core.getMiningInfo();
        return {
          running: this.miningRunning,
          hashrate: mining.hashrate,
          acceptedShares: 0,
          rejectedShares: 0,
          lastShareAt: null,
        };
      }
      case "startmining":
        this.miningRunning = true;
        return "mining started";
      case "stopmining":
        this.miningRunning = false;
        return "mining stopped";
      case "stop":
        setTimeout(() => this.core.requestStop(), 50);
        return "stopping";
      default:
        throw methodNotFound(method);
    }
  }
}

function parameterError(message: string): Error {
  return codedError(RPC_INVALID_PARAMS, message);
}

function methodNotFound(method: string): Error {
  return codedError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

function codedError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}
