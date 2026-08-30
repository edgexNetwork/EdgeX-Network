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

  /** 本地游戏网关端口（dexcoin.conf gameport）；未配置则不启动游戏网关 */
  gamePort?: number;
  /** 允许连接的游戏页面 Origin 列表（dexcoin.conf gameorigins，可重复；空 = 拒绝全部游戏连接） */
  gameOrigins: string[];
  /** 游戏配对令牌（dexcoin.conf gamepairtoken，可选）：与 Origin 白名单互为纵深，游戏页 hello 需携带 */
  gamePairToken: string;
  /** 单次游戏上传自动签名小费上限（EDX，gamefee，默认 0.001）：同时也是默认小费金额 */
  gameFee: string;
  /** 每日游戏小费累计上限（EDX，gamefeeperday，默认 0.5；超限拒绝上传，防本地端口被攻破盗刷） */
  gameFeePerDay: string;
  /** 游戏小费收款地址（gamefeeaddress）：每笔上传自动签名的小费交易发往该地址；未配置时上传被拒 */
  gameFeeAddress: string;
  /** 上榜最低分数（gameminscore，默认 0） */
  gameMinScore: number;
  /** 结算周期奖励档位（gamerewards，可重复，EDX；默认空 = 不设奖励） */
  gameRewards: string[];
  /** 每日结算小时（UTC，gamesettlehourutc，默认 8，即每日 08:00 UTC） */
  gameSettleHourUtc: number;
  /** 上传数据体积上限（字节，gamemaxsize，默认 65536） */
  gameMaxSize: number;
  /** 上传频率上限（次/分钟，gamemaxfreq，默认 60） */
  gameMaxFreq: number;
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

  // 游戏网关端口（gameport）：与 rpcport 同语义（可选正整数），但先剥离外层引号
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
  };
  return { config, warnings };
}

/** 剥离配置值外层成对引号（bitcoin.conf 风格：可选加引号，解析时去除）。 */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}
