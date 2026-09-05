import { createHash, timingSafeEqual } from "node:crypto";
import type { WalletCore } from "../core/walletCore";
import type { TxView } from "../api/types";
import type { Logger } from "../utils/log";
import type { WalletConfig } from "../config/config";
import { decodeBlockHex, submitBlock } from "../core/rpcCore";
import { DEFAULT_HISTORY_COUNT, parseCount, parseSkip } from "../core/paging";

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_GENERIC = -1;
const RPC_INVALID_ADDRESS_OR_KEY = -5;

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

/** Estimated network difficulty derived from the live network power. */
function miningDifficulty(networkPower: number): number {
  return Math.max(1, Math.floor(networkPower * 15));
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Local bitcoind-style JSON-RPC compatibility surface for the decentralized
 * wallet core. Exposes the full method set the legacy wallet documented:
 * wallet, raw transaction, mempool, block, mining and node control methods.
 *
 * `submitblock` is real: the hex payload is decoded into the consensus block
 * shape and forwarded to the connected full node's `/blocks` endpoint, where
 * the actual consensus pipeline validates and persists it.
 */
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
      // ---- chain info ----
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
      case "getnewaddress": {
        const label = typeof params[0] === "string" ? params[0] : undefined;
        return this.core.getNewAddress(label);
      }
      case "sendtoaddress": {
        // bitcoind parameter surface: <address> <amount> followed by optional
        // comment/comment_to/fee_rate/subtract_fee_from_amount arguments that
        // EDX does not model. Extra optional parameters are tolerated and
        // ignored so standard Bitcoin wallet tooling keeps working.
        this.requireParams(params, 2, 9);
        const [to, amount, fee, password] = params;
        if (typeof to !== "string" || (typeof amount !== "string" && typeof amount !== "number")) {
          throw parameterError("sendtoaddress parameter error: <address> <amount> [fee] [password]");
        }
        if (password !== undefined && typeof password !== "string") {
          throw parameterError("sendtoaddress password parameter must be a string");
        }
        const explicitFee = typeof fee === "string" ? fee : null;
        return this.core.send([{ address: to, amount: String(amount) }], { explicitFee }, typeof password === "string" ? password : undefined);
      }
      case "gettransaction": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("gettransaction requires a txid");
        // Wallet-scoped semantics: unknown ids and third-party transactions
        // that never touched this wallet are reported as an error (-5), the
        // bitcoind convention. Full-chain lookups belong to getrawtransaction.
        const transaction = await this.core.getTransaction(params[0]);
        if (!transaction) {
          throw codedError(RPC_INVALID_ADDRESS_OR_KEY, "Invalid or non-wallet transaction id");
        }
        return transactionDto(transaction);
      }
      case "listtransactions": {
        // bitcoind parameter surface: [label] [count] [skip] [include_watchonly].
        // The leading label is a string in Bitcoin Core; when present it is
        // accepted and ignored because EDX wallets have no labels. count/skip
        // window the merged wallet history (count defaults to 20).
        this.requireParams(params, 0, 4);
        let count: unknown = params[0];
        let skip: unknown = params[1];
        if (typeof params[0] === "string") {
          count = params[1];
          skip = params[2];
        }
        const parsedCount = parseCount(count, DEFAULT_HISTORY_COUNT);
        const parsedSkip = parseSkip(skip);
        const all = await this.core.listTransactions(parsedCount, parsedSkip);
        // The core honors (limit, skip); the extra slice guards stubs and
        // future core changes that might over-return.
        return all.slice(0, parsedCount).map(transactionDto);
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

      // ---- transfers ----
      case "sendmany": {
        // bitcoind surface: <dummyaccount> <amounts> [minconf] [comment]
        // [subtractfeefromamount] [replaceable] [conf_target] [estimate_mode]
        // [fee_rate] [verbose]. Optional parameters after the amounts map are
        // tolerated and ignored; a trailing string argument is the wallet
        // password (EDX extension) when the vault requires one.
        this.requireParams(params, 2, 10);
        const [dummy, amounts, ...rest] = params;
        if (typeof amounts !== "object" || amounts === null || Array.isArray(amounts)) {
          throw parameterError("sendmany requires an amounts object {address: amount}");
        }
        let password: unknown;
        for (let index = rest.length - 1; index >= 0; index -= 1) {
          const candidate = rest[index];
          if (typeof candidate === "string" && candidate !== "true" && candidate !== "false") {
            password = candidate;
            break;
          }
        }
        const payments = Object.entries(amounts as Record<string, unknown>).map(([address, amount]) => ({
          address,
          amount: String(amount),
        }));
        return this.core.send(payments, {}, typeof password === "string" ? password : undefined);
      }
      case "send": {
        this.requireParams(params, 1, 3);
        const [outputs, , , password] = params;
        if (!Array.isArray(outputs)) {
          throw parameterError("send requires an outputs array [{address, amount}]");
        }
        const payments = (outputs as Array<{ address?: unknown; amount?: unknown }>).map((output) => ({
          address: String(output.address ?? ""),
          amount: String(output.amount ?? ""),
        }));
        return this.core.send(payments, {}, typeof password === "string" ? password : undefined);
      }
      case "sendall": {
        this.requireParams(params, 1, 2);
        const [addresses, password] = params;
        if (!Array.isArray(addresses) || addresses.length === 0 || typeof addresses[0] !== "string") {
          throw parameterError("sendall requires a target address array");
        }
        const utxos = await this.core.listUnspent(0, 9999999);
        const total = utxos.reduce((sum, u) => sum + parseAmount(u.amount), 0n);
        if (total <= 0n) throw codedError(RPC_GENERIC, "No spendable balance to send");
        return this.core.send([{ address: addresses[0], amount: formatAmount(total) }], {}, typeof password === "string" ? password : undefined);
      }

      // ---- signing and message auth ----
      case "signrawtransactionwithwallet": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("signrawtransactionwithwallet requires hexstring");
        return this.core.signRawTransaction(params[0]);
      }
      case "signmessage": {
        this.requireParams(params, 2, 3);
        const [address, message, password] = params;
        if (typeof address !== "string" || typeof message !== "string") {
          throw parameterError("signmessage requires <address> <message> [password]");
        }
        return this.core.signMessageForAddress(address, message, typeof password === "string" ? password : "");
      }
      case "verifymessage": {
        this.requireParams(params, 3, 3);
        const [address, signature, message] = params;
        if (typeof address !== "string" || typeof signature !== "string" || typeof message !== "string") {
          throw parameterError("verifymessage requires <address> <signature> <message>");
        }
        return this.core.verifyMessageForAddress(address, message, signature);
      }
      case "walletprocesspsbt":
        throw codedError(RPC_METHOD_NOT_FOUND, "walletprocesspsbt is not supported: EDX has no PSBT (BIP174) transactions");

      // ---- private keys and wallet export ----
      case "dumpprivkey": {
        this.requireParams(params, 1, 2);
        const [address, password] = params;
        if (typeof address !== "string") throw parameterError("dumpprivkey requires <address> [password]");
        return this.core.dumpPrivKey(address, typeof password === "string" ? password : "");
      }
      case "dumpwallet": {
        this.requireParams(params, 1, 2);
        const [filename, password] = params;
        if (typeof filename !== "string") throw parameterError("dumpwallet requires <filename> [password]");
        const addresses = this.core.walletAddresses();
        const lines = addresses.map((addr) => `${addr} ${this.core.dumpPrivKey(addr, typeof password === "string" ? password : "")}`);
        return lines.join("\n");
      }

      // ---- password and encryption lifecycle ----
      case "walletpassphrase": {
        this.requireParams(params, 2, 2);
        const [passphrase, timeout] = params;
        if (typeof passphrase !== "string" || typeof timeout !== "number") {
          throw parameterError("walletpassphrase requires <passphrase> <timeout>");
        }
        if (!this.core.unlock(passphrase)) {
          throw codedError(RPC_GENERIC, "Wrong wallet passphrase");
        }
        return null;
      }
      case "walletlock":
        this.core.lock();
        return null;
      case "walletpassphrasechange":
        throw codedError(RPC_METHOD_NOT_FOUND, "walletpassphrasechange is not supported: EDX vault password change is done via CLI (init --force)");
      case "encryptwallet":
        throw codedError(RPC_METHOD_NOT_FOUND, "encryptwallet is not supported: EDX wallets are created with a password (vault)");

      // ---- wallet read-only, balances and address management ----
      case "getbalances":
        return this.core.getBalances();
      case "getwalletinfo":
        return this.core.getWalletInfo();
      case "getrawchangeaddress":
        return this.core.getRawChangeAddress();
      case "validateaddress": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("validateaddress requires <address>");
        return this.core.validateAddress(params[0]);
      }
      case "getaddressinfo": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("getaddressinfo requires <address>");
        return this.core.getAddressInfo(params[0]);
      }
      case "listunspent": {
        // bitcoind surface: [minconf] [maxconf] [addresses] [include_unsafe]
        // [query_options]. Pagination travels inside query_options as
        // {count, skip} (count default 100, capped at 500).
        this.requireParams(params, 0, 5);
        const minconf = typeof params[0] === "number" ? Math.floor(params[0]) : 0;
        const maxconf = typeof params[1] === "number" ? Math.floor(params[1]) : 9999999;
        const addresses = Array.isArray(params[2]) ? (params[2] as unknown[]).filter((a): a is string => typeof a === "string") : undefined;
        const options = params[4] as { count?: unknown; skip?: unknown } | undefined;
        const count = parseCount(options?.count);
        const skip = parseSkip(options?.skip);
        const utxos = await this.core.listUnspent(minconf, maxconf, addresses);
        const window = utxos.slice(skip, skip + count);
        return window.map((u) => ({
          txid: u.txid,
          vout: u.index,
          address: u.address,
          amount: u.amount,
          confirmations: u.confirmations,
          spendable: true,
          solvable: true,
          safe: true,
        }));
      }
      case "listaddresses": {
        // EDX extension: every derived wallet address (external + internal),
        // main address first, windowed by [count] [skip].
        this.requireParams(params, 0, 2);
        const count = parseCount(params[0]);
        const skip = parseSkip(params[1]);
        const all = this.core.walletAddresses();
        return all.slice(skip, skip + count);
      }
      case "listsinceblock": {
        const blockhash = typeof params[0] === "string" ? params[0] : undefined;
        const result = await this.core.listSinceBlock(blockhash);
        return { transactions: result.transactions.map(transactionDto), lastblock: result.lastblock };
      }
      case "importaddress": {
        this.requireParams(params, 1, 2);
        const [address, label] = params;
        if (typeof address !== "string") throw parameterError("importaddress requires <address> [label]");
        this.core.importAddress(address, typeof label === "string" ? label : undefined);
        return null;
      }
      case "importdescriptors":
        throw codedError(RPC_METHOD_NOT_FOUND, "importdescriptors is not supported: EDX has no output descriptors");
      case "loadwallet":
        throw codedError(RPC_METHOD_NOT_FOUND, "loadwallet is not supported: single-wallet per datadir");
      case "unloadwallet":
        throw codedError(RPC_METHOD_NOT_FOUND, "unloadwallet is not supported: single-wallet per datadir");
      case "createwallet":
        throw codedError(RPC_METHOD_NOT_FOUND, "createwallet is not supported: use CLI init to create a wallet");

      // ---- raw transactions and PSBT ----
      case "createrawtransaction": {
        this.requireParams(params, 2, 2);
        const [inputs, outputs] = params;
        if (!Array.isArray(inputs) || typeof outputs !== "object" || outputs === null) {
          throw parameterError("createrawtransaction requires <inputs> <outputs>");
        }
        const outArr = Object.entries(outputs as Record<string, unknown>).map(([address, amount]) => ({
          address,
          amount: String(amount),
        }));
        const rawTx = {
          inputs: (inputs as Array<{ txid?: unknown; vout?: unknown }>).map((input) => ({
            txid: String(input.txid ?? ""),
            index: Number(input.vout ?? 0),
          })),
          outputs: outArr,
          fee: "0",
        };
        return encodeRawTxHex(rawTx);
      }
      case "fundrawtransaction": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("fundrawtransaction requires hexstring");
        return this.core.fundRawTransaction(params[0]);
      }
      case "decoderawtransaction": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("decoderawtransaction requires hexstring");
        return this.core.decodeRawTransaction(params[0]);
      }
      case "decodescript":
        throw codedError(RPC_METHOD_NOT_FOUND, "decodescript is not supported: EDX has no script language");
      case "sendrawtransaction": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("sendrawtransaction requires hexstring");
        return this.core.sendRawTransaction(params[0]);
      }
      case "testmempoolaccept": {
        this.requireParams(params, 1, 1);
        if (!Array.isArray(params[0])) throw parameterError("testmempoolaccept requires an array of hexstrings");
        return this.core.testMempoolAccept(params[0]);
      }
      case "createpsbt":
      case "decodepsbt":
      case "combinepsbt":
      case "finalizepsbt":
        throw codedError(RPC_METHOD_NOT_FOUND, `${method} is not supported: EDX has no PSBT (BIP174) transactions`);

      // ---- UTXO, mempool and fees ----
      case "scantxoutset": {
        // bitcoind semantics: "start <scanobjects> [scaninfo]" scans the
        // full-chain UTXO set for the given addresses; scaninfo carries
        // {count, skip} for windowing the unspents (txouts and total_amount
        // always reflect the whole match set). "abort" and "status" only
        // report that the synchronous scan cannot be interrupted.
        this.requireParams(params, 1, 3);
        const [action, scanobjects, scaninfo] = params;
        if (action === "abort" || action === "status") {
          return { success: false, txouts: 0, total_amount: "0.00000000", unspents: [] };
        }
        if (action !== "start" || !Array.isArray(scanobjects)) {
          throw parameterError("scantxoutset requires start <scanobjects> [scaninfo] | abort | status");
        }
        const info = scaninfo as { count?: unknown; skip?: unknown } | undefined;
        const count = parseCount(info?.count);
        const skip = parseSkip(info?.skip);
        const result = await this.core.scanTxOutSet(scanobjects);
        return {
          success: result.success,
          txouts: result.txouts,
          total_amount: result.total_amount,
          unspents: result.unspents.slice(skip, skip + count),
        };
      }
      case "gettxout": {
        this.requireParams(params, 2, 2);
        const [txid, n] = params;
        if (typeof txid !== "string" || typeof n !== "number") {
          throw parameterError("gettxout requires <txid> <n>");
        }
        return this.core.getTxOut(txid, Math.floor(n));
      }
      case "gettxoutsetinfo":
        return this.core.getTxOutSetInfo();
      case "getrawmempool": {
        const mempool = await this.core.getRawMempool();
        return params[0] === true ? Object.fromEntries(mempool.map((txid) => [txid, { size: 250, fee: "0" }])) : mempool;
      }
      case "getmempoolentry": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "string") throw parameterError("getmempoolentry requires txid");
        const txid = params[0];
        const raw = await this.core.getRawTransaction(txid);
        if (!raw) throw codedError(RPC_GENERIC, "Transaction not found in mempool");
        return { txid, vsize: 250, fee: "0", depends: [] };
      }
      case "getmempoolinfo":
        return this.core.getMempoolInfo();

      // ---- blockchain and sync ----
      case "getblockhash": {
        this.requireParams(params, 1, 1);
        if (typeof params[0] !== "number") throw parameterError("getblockhash requires <height>");
        const hash = this.core.getBlockHash(Math.floor(params[0]));
        if (!hash) throw codedError(RPC_GENERIC, "Block height out of range");
        return hash;
      }
      case "getblockheader": {
        this.requireParams(params, 1, 2);
        if (typeof params[0] !== "string") throw parameterError("getblockheader requires <blockhash>");
        const header = this.core.getBlockHeader(params[0]);
        if (!header) throw codedError(RPC_GENERIC, "Block not found");
        return params[1] === false ? header.hash : header;
      }
      case "getblock": {
        this.requireParams(params, 1, 2);
        if (typeof params[0] !== "string") throw parameterError("getblock requires <blockhash>");
        const block = this.core.getBlock(params[0]);
        if (!block) throw codedError(RPC_GENERIC, "Block not found");
        return params[1] === 0 ? block.hash : block;
      }
      case "getchaintips": {
        const chain = await this.core.getChainInfo();
        return [{ height: chain.blocks, hash: chain.latestHash, branchlen: 0, status: "active" }];
      }
      case "getrawtransaction": {
        // bitcoind semantics: getrawtransaction <txid> [verbose] [blockhash].
        // Without verbose the raw hex(UTF-8 JSON) body is returned; with
        // verbose=true a structured view of any on-chain transaction comes back
        // (full-chain lookup, not limited to this wallet's history).
        this.requireParams(params, 1, 3);
        if (typeof params[0] !== "string") throw parameterError("getrawtransaction requires txid");
        if (params[1] === true) {
          const verbose = await this.core.getRawTransactionVerbose(params[0]);
          if (!verbose) throw codedError(RPC_GENERIC, "Transaction not found");
          return verbose;
        }
        const raw = await this.core.getRawTransaction(params[0]);
        if (!raw) throw codedError(RPC_GENERIC, "Transaction not found");
        return raw;
      }

      // ---- network connections and node control ----
      case "getnetworkinfo": {
        const count = this.core.getConnectionCount();
        return {
          version: 1,
          subversion: "/EDX:1.0/",
          protocolversion: 70016,
          connections: count,
          relayfee: "0.00001000",
        };
      }
      case "addnode": {
        this.requireParams(params, 2, 2);
        const [node, command] = params;
        if (typeof node !== "string" || typeof command !== "string") {
          throw parameterError("addnode requires <node> <command>");
        }
        if (command === "add") {
          this.core.addNode(node);
          return null;
        }
        if (command === "remove") {
          this.core.removeNode(node);
          return null;
        }
        throw parameterError("addnode command must be 'add' or 'remove'");
      }
      case "ping":
        return null;

      // ---- mining and block submission ----
      case "getblocktemplate": {
        const chain = await this.core.getChainInfo();
        return {
          capabilities: ["proposal"],
          version: 1,
          height: chain.blocks,
          previousblockhash: chain.latestHash,
          curtime: Math.floor(Date.now() / 1000),
          bits: "1d00ffff",
          target: "00000000ffff0000000000000000000000000000000000000000000000000000",
          coinbasevalue: chain.blockReward,
          transactions: [],
        };
      }
      case "submitblock": {
        this.requireParams(params, 1, 2);
        if (typeof params[0] !== "string") {
          throw parameterError("submitblock requires <hexdata> [dummy]");
        }
        // The block body is hex of UTF-8 JSON (the same convention as raw
        // transactions). It is decoded into the consensus block shape and
        // submitted to the connected node, which runs the real validation
        // (merkle root, PoW, difficulty, timestamps, UTXO state) and persists
        // the block on success. Bitcoind-style status strings are returned:
        //   "duplicate"    - the block hash is already known
        //   "inconclusive" - the block built on a side branch (fork)
        //   "unknown"      - the payload could not be decoded
        //   "rejected"     - the block failed consensus validation
        const block = decodeBlockHex(params[0]);
        if (!block) return "unknown";
        const outcome = await submitBlock(this.core.conn, block);
        switch (outcome.status) {
          case "duplicate":
            return "duplicate";
          case "inconclusive":
            return "inconclusive";
          case "rejected":
            return { status: "rejected", reject_reason: outcome.rejectReason ?? "unknown error" };
          default:
            // Accepted: the block extended the best chain (null, bitcoind convention).
            return null;
        }
      }
      case "generatetoaddress":
        throw codedError(RPC_METHOD_NOT_FOUND, "generatetoaddress is not supported: no regtest block generation in EDX");

      case "getmininginfo": {
        const chain = await this.core.getChainInfo();
        return {
          blocks: chain.blocks,
          difficulty: miningDifficulty(chain.networkPower),
          networkhashps: chain.networkPower,
          pooledtx: chain.pendingCount,
          chain: "edx",
        };
      }
      case "getnetworkhashps":
        return (await this.core.getMiningInfo()).networkHashps;
      case "getminingjob": {
        const chain = await this.core.getChainInfo();
        const difficulty = miningDifficulty(chain.networkPower);
        const target = ((1n << 256n) - 1n) / BigInt(difficulty);
        return {
          jobId: sha256Hex(`${chain.blocks}:${chain.latestHash}`),
          height: chain.blocks,
          previousblockhash: chain.latestHash,
          curtime: Math.floor(Date.now() / 1000),
          difficulty,
          target: target.toString(16).padStart(64, "0"),
          coinbasevalue: chain.blockReward,
          version: 1,
          noncerange: ["00000000", "ffffffff"],
        };
      }
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

/** Amount strings are EDX with up to 8 decimals. */
function parseAmount(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (!match) return 0n;
  return BigInt(match[1]!) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
}

function formatAmount(photons: bigint): string {
  const s = photons.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

function encodeRawTxHex(tx: unknown): string {
  return Buffer.from(JSON.stringify(tx), "utf8").toString("hex");
}
