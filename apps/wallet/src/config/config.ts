import path from "node:path";
import {
  confGet,
  confGetAll,
  confGetBool,
  confGetInt,
  confGetIntOpt,
  parseConf,
} from "./confParser";

export const DEFAULT_RPC_PORT = 18332;
export const DEFAULT_P2P_PORT = 28332;

export const DEFAULT_NODE_URL = "http://127.0.0.1:28332";
export const CONFIG_FILE_NAME = "dexcoin.conf";
export const MNEMONIC_FILE_NAME = "wallet.mnemonic";
export const VAULT_FILE_NAME = "wallet.vault";

export const CHAIN_DB_FILE_NAME = "chain.db";
/** Default threshold (bytes) for segmenting the local chain database: when the active database grows past this size it is sealed into read-only compressed segments. */
export const DEFAULT_MAX_SEGMENT_BYTES = 500 * 1024 * 1024;

export interface WalletConfig {
  datadir: string;
  confPath: string;
  server: boolean;
  rpcuser: string;
  rpcpassword: string;

  rpcport?: number;

  listen: boolean;

  port?: number;
  addnodes: string[];
  nodeUrl?: string;

  /** Local game gateway port (dexcoin.conf gameport); the gateway is not started when unset */
  gamePort?: number;
  /** Allowed game page Origins (dexcoin.conf gameorigins, repeatable; empty = reject all game connections) */
  gameOrigins: string[];
  /** Game pairing token (dexcoin.conf gamepairtoken, optional): defense in depth alongside the Origin whitelist; the game page hello must include it */
  gamePairToken: string;
  /** Per-upload auto-signed tip cap (EDX, gamefee, default 0.001); also the default tip amount */
  gameFee: string;
  /** Daily cumulative game tip cap (EDX, gamefeeperday, default 0.5; uploads over the cap are rejected to prevent drain if the local port is compromised) */
  gameFeePerDay: string;
  /** Game tip recipient address (gamefeeaddress): each upload's auto-signed tip transaction is sent here; uploads are rejected when unset */
  gameFeeAddress: string;
  /** Minimum score to qualify for the leaderboard (gameminscore, default 0) */
  gameMinScore: number;
  /** Settlement cycle reward tiers (gamerewards, repeatable, EDX; empty by default = no rewards) */
  gameRewards: string[];
  /** Daily settlement hour (UTC, gamesettlehourutc, default 8, i.e. 08:00 UTC) */
  gameSettleHourUtc: number;
  /** Upload data size cap (bytes, gamemaxsize, default 65536) */
  gameMaxSize: number;
  /** Upload rate cap (per minute, gamemaxfreq, default 60) */
  gameMaxFreq: number;
  /** Local chain database segmentation threshold (bytes, maxsegmentbytes); the active database is sealed once exceeded */
  maxSegmentBytes: number;
}

export function defaultDatadir(): string {
  return path.join(process.cwd(), "EDX_DATA");
}

export interface CliPaths {
  conf?: string;
  datadir?: string;

  dev?: boolean;
}

export interface ResolvedConfig {
  config: WalletConfig;
  warnings: string[];
}


export function parseCliPaths(argv: string[]): { paths: CliPaths; rest: string[] } {
  const paths: CliPaths = {};
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "-dev" || arg === "--dev") {
      paths.dev = true;
      continue;
    }
    if (arg.startsWith("-conf=")) paths.conf = arg.slice(6);
    else if (arg.startsWith("-datadir=")) paths.datadir = arg.slice(9);
    else rest.push(arg);
  }
  return { paths, rest };
}

export function resolveConfig(cliPaths: CliPaths): ResolvedConfig {
  const warnings: string[] = [];
  const baseDatadir = cliPaths.datadir ?? defaultDatadir();
  const confPath = cliPaths.conf ?? path.join(baseDatadir, CONFIG_FILE_NAME);

  let raw = new Map<string, string[]>();
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    raw = parseConf(fs.readFileSync(confPath, "utf8"));
  } catch {
    if (cliPaths.conf) warnings.push(`Config file not found: ${confPath}; using defaults`);
  }

const datadir = cliPaths.datadir ?? confGet(raw, "datadir") ?? baseDatadir;
  const rpcport = confGetIntOpt(raw, "rpcport");
  const port = confGetIntOpt(raw, "port");

  // Game gateway port (gameport): same semantics as rpcport (optional positive integer), but strip outer quotes first
  const gamePort = (() => {
    const rawValue = confGet(raw, "gameport");
    if (rawValue === undefined) return undefined;
    const n = Number.parseInt(unquote(rawValue), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  const config: WalletConfig = {
    datadir,
    confPath,
    server: confGetBool(raw, "server", true),
    rpcuser: confGet(raw, "rpcuser") ?? "",
    rpcpassword: confGet(raw, "rpcpassword") ?? "",
    rpcport,

    listen: confGetBool(raw, "listen", true),
    port,
    addnodes: (() => {
      const nodes = confGetAll(raw, "addnode").filter((n) => n.trim() !== "");
      if (nodes.length > 0) return nodes;
      return [DEFAULT_NODE_URL];
    })(),
    nodeUrl: (confGet(raw, "node") ?? DEFAULT_NODE_URL).trim(),

    gamePort,
    gameOrigins: confGetAll(raw, "gameorigins")
      .map((origin) => unquote(origin))
      .filter((origin) => origin !== ""),
    gamePairToken: unquote(confGet(raw, "gamepairtoken") ?? ""),
    gameFee: unquote(confGet(raw, "gamefee") ?? "") || "0.001",
    gameFeePerDay: unquote(confGet(raw, "gamefeeperday") ?? "") || "0.5",
    gameFeeAddress: unquote(confGet(raw, "gamefeeaddress") ?? "").trim(),
    gameMinScore: Math.max(0, confGetInt(raw, "gameminscore", 0)),
    gameRewards: confGetAll(raw, "gamerewards")
      .map((amount) => unquote(amount).trim())
      .filter((amount) => amount !== ""),
    gameSettleHourUtc: Math.min(23, Math.max(0, confGetInt(raw, "gamesettlehourutc", 8))),
    gameMaxSize: Math.max(0, confGetInt(raw, "gamemaxsize", 65536)),
    gameMaxFreq: Math.max(0, confGetInt(raw, "gamemaxfreq", 60)),
    maxSegmentBytes: Math.max(confGetInt(raw, "maxsegmentbytes", DEFAULT_MAX_SEGMENT_BYTES), 16 * 1024 * 1024),
  };
  return { config, warnings };
}

/** Strip paired outer quotes from a config value (bitcoin.conf style: quotes are optional and removed when parsing). */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}
