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
};
  return { config, warnings };
}
