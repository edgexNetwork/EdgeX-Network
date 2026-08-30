#!/usr/bin/env bun
import { render } from "ink";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { parseCliPaths, resolveConfig, type CliPaths, type WalletConfig } from "./config/config";
import { Logger } from "./utils/log";
import {
  createOrLoadKey,
  loadWalletKey,
  loadWalletWithRetry,
  type WalletKey,
} from "./keys/walletKeyClean";
import {
  hasLegacyMnemonic,
  hasVault,
  hasWalletFile,
  promptLine,
  promptNewPassword,
  promptSecret,
  vaultFilePath,
} from "./keys/vaultLegacy";
import { WalletCore } from "./core/walletCore";
import { initGlobalData } from "./core/globalData";
import { loadOrCreateCommKey, type CommKey } from "./keys/commKey";
import { GameGate } from "./game/gameGate";
import { CommandRegistry } from "./commands/registry";
import { builtinCommands } from "./commands/commands";
import { App } from "./tui/App";
import { Onboarding } from "./tui/Onboarding";
import { warnAndPromptTuiEnv } from "./tui/envCheck";
import { applyStoredLang, currentLocale, t } from "./i18n";
import { startWalletRpc } from "./rpc/lifecycle";

const VERSION = "1.0.0";

function printHelp(): void {
  console.log(`EdgeX Network Wallet (EDX) v${VERSION}

Usage:
  edgex-wallet                       Start the full TUI (onboarding, top bar, dual modes)
  edgex-wallet daemon                Start without UI (node polling remains active)
  edgex-wallet init                  Create a wallet interactively
  edgex-wallet init --restore        Import a wallet interactively
  edgex-wallet <command> [args...]   Run one command (balance, send, history, ...)

Global options:
  -conf=FILE       Configuration path (default <datadir>/dexcoin.conf)
  -datadir=DIR     Data directory (default ./EDX_DATA)
  --help / --version

Commands:
  help | info | balance | receive | history [count] | tx <txid>
  send <address>:<amount> [...] [fee] [slow|normal|fast] [password]
  mnemonic <password>
  peers | addnode <http://host:port> | fees | sync | lang [zh|en|ru|ja] | stop
`);
}

function parseInitArgs(args: string[]): { restore?: string; restoreRequested: boolean; force: boolean } {
  let restore: string | undefined;
  let restoreRequested = false;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--force" || argument === "-f") force = true;
    else if (argument === "--restore" || argument === "-r") {
      restoreRequested = true;
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        restore = next;
        index += 1;
      }
    } else if (argument.startsWith("--restore=")) {
      restoreRequested = true;
      restore = argument.slice(10);
    }
  }
  return { restore, restoreRequested, force };
}

function serviceSummary(config: WalletConfig): string {
  const game = config.gamePort !== undefined ? String(config.gamePort) : t("log.notConfigured");
  return (
    t("log.serviceSummary", {
      rpc: config.rpcport !== undefined ? String(config.rpcport) : t("log.notConfigured"),
      p2p: config.port !== undefined ? String(config.port) : t("log.notConfigured"),
    }) + " | " + t("log.gameSummary", { game })
  );
}

function joinNodes(nodes: string[]): string {
  return nodes.join(currentLocale() === "zh" ? "、" : ", ");
}

function buildServices(config: WalletConfig, key: WalletKey, log: Logger, password?: string) {
  let commKey: CommKey | undefined;
  try {
    commKey = loadOrCreateCommKey(config.datadir, { onWarn: (m) => log.warn(m), password });
  } catch (e) {
    log.warn(`Communication key load failed: ${(e as Error).message}; game saves will not be encrypted`);
  }
  const core = new WalletCore(config, key, log);
  const registry = new CommandRegistry();
  registry.registerAll(builtinCommands());
  const game =
    config.gamePort !== undefined && config.gamePort > 0
      ? new GameGate({ config, core, commKey, password, log })
      : null;
  return { core, registry, game };
}

function runOnboarding(config: WalletConfig, log: Logger): Promise<{ key: WalletKey; created: boolean }> {
  return new Promise((resolve) => {
    process.stdout.write("\x1b[2J\x1b[H");
    const application = render(
      <Onboarding
        datadir={config.datadir}
        log={log}
        onDone={(key, created) => {
          application.unmount();
          resolve({ key, created });
        }}
        onExit={() => {
          application.unmount();
          process.exit(0);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}

async function loadExistingWallet(config: WalletConfig, log: Logger): Promise<{ key: WalletKey; password: string }> {
  try {
    return await loadWalletWithRetry(config.datadir);
  } catch (error) {
    const message = (error as Error).message;
    log.error(`Wallet load failed: ${message}`);
    console.error(`Wallet load failed: ${message}`);
    process.exit(1);
  }
}

async function startWallet(paths: CliPaths, tui: boolean): Promise<void> {
  const { config, warnings } = resolveConfig(paths);
  mkdirSync(config.datadir, { recursive: true });
  initGlobalData();
  applyStoredLang(config.datadir);
  const log = new Logger({ console: !tui, file: path.join(config.datadir, "dexcoin.log") });
  warnings.forEach((warning) => log.warn(warning));
  if (tui && process.stdout.isTTY) await warnAndPromptTuiEnv(log);

  let key: WalletKey;
  let password: string | undefined;
  let created = false;
  if (!hasWalletFile(config.datadir)) {
    if (!tui || !process.stdout.isTTY) {
      console.error(`Wallet not initialized: ${vaultFilePath(config.datadir)} missing`);
      process.exit(1);
    }
    const result = await runOnboarding(config, log);
    key = result.key;
    created = result.created;
  } else {
    const loaded = await loadExistingWallet(config, log);
    key = loaded.key;
    password = loaded.password;
  }

  const message = created ? t("log.walletCreated", { address: key.address }) : t("log.walletLoaded", { address: key.address });
  if (created) log.warn(message);
  else log.info(message);

  const { core, registry, game } = buildServices(config, key, log, password);
  const rpc = startWalletRpc(config, core, log);
  try {
    await core.start();
    game?.start();
  } catch (error) {
    rpc?.stop();
    game?.stop();
    console.error(`Startup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    rpc?.stop();
    game?.stop();
    void core.stop().finally(() => process.exit(0));
  };
  core.bus.on("shutdown", exit);
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);

  if (!tui || !process.stdout.isTTY) {
    log.info(t("log.daemonRunning", { summary: serviceSummary(config), nodes: joinNodes(config.addnodes) }));
    return;
  }

  process.stdout.write("\x1b[2J\x1b[H");
  const application = render(<App core={core} log={log} registry={registry} config={config} onExit={exit} />, {
    exitOnCtrlC: false,
  });
  log.info(t("log.tuiStarted", { summary: serviceSummary(config), nodes: joinNodes(config.addnodes) }));
  core.bus.on("shutdown", () => application.unmount());
}

async function initWallet(paths: CliPaths, args: string[]): Promise<void> {
  const { config, warnings } = resolveConfig(paths);
  initGlobalData();
  warnings.forEach((warning) => console.warn(warning));
  const { restore, restoreRequested, force } = parseInitArgs(args);
  mkdirSync(config.datadir, { recursive: true });
  applyStoredLang(config.datadir);

  if (hasVault(config.datadir) && !force) {
    console.log(`Wallet already exists: ${vaultFilePath(config.datadir)} (unchanged; pass --force to rebuild)`);
    return;
  }
  if (hasLegacyMnemonic(config.datadir) && !force) {
    console.log("Detected legacy plaintext wallet wallet.mnemonic; migrating to encrypted wallet.vault");
    const password = await promptNewPassword();
    const result = createOrLoadKey(config.datadir, { password });
    console.log(`Address: ${result.key.address}\nMigration complete`);
    return;
  }
  if (force && hasVault(config.datadir)) {
    const oldPassword = await promptSecret(t("prompt.originalPassword"));
    try {
      loadWalletKey(config.datadir, oldPassword);
    } catch {
      console.error("Original wallet password incorrect; rebuild cancelled");
      process.exit(1);
    }
    renameSync(vaultFilePath(config.datadir), `${vaultFilePath(config.datadir)}.bak`);
  }

  const password = await promptNewPassword();
  let mnemonic: string | undefined;
  if (restoreRequested) mnemonic = restore ?? (await promptLine(t("prompt.mnemonic")));
  const { key, created } = createOrLoadKey(config.datadir, { password, mnemonic, force });
  if (created && mnemonic !== undefined) console.log("Wallet restored");
  else if (created) {
    console.log("Wallet initialized. Back up this mnemonic offline now:");
    console.log(`\n  ${key.mnemonic}\n`);
  }
  console.log(`Address: ${key.address}\nDerivation path: ${key.derivationPath}\nWallet file: ${vaultFilePath(config.datadir)}`);
}

async function runOneShot(command: string, args: string[], paths: CliPaths): Promise<void> {
  const { config, warnings } = resolveConfig(paths);
  initGlobalData();
  applyStoredLang(config.datadir);
  const log = new Logger({ console: false });
  warnings.forEach((warning) => console.warn(warning));
  if (!hasWalletFile(config.datadir)) {
    console.error(`Wallet not initialized: ${vaultFilePath(config.datadir)} missing; run init first`);
    process.exit(1);
  }
  const loaded = await loadExistingWallet(config, log);
  const { core, registry } = buildServices(config, loaded.key, log, loaded.password);
  await core.start().catch(() => undefined);
  try {
    const output = await registry.execute(`${command} ${args.join(" ")}`, {
      core,
      log,
      interactive: true,
      password: loaded.password,
      datadir: config.datadir,
    });
    console.log(output);
    process.exit(/^(Unknown command|Error)/.test(output) ? 1 : 0);
  } finally {
    await core.stop();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help") || arguments_.includes("-h")) return printHelp();
  if (arguments_.includes("--version") || arguments_.includes("-v")) return console.log(`edgex-wallet v${VERSION}`);
  const { paths, rest } = parseCliPaths(arguments_);
  const [command, ...args] = rest;
  if (!command || command === "start") return startWallet(paths, true);
  if (command === "daemon") return startWallet(paths, false);
  if (command === "init") return initWallet(paths, args);
  return runOneShot(command, args, paths);
}

main().catch((error) => {
  console.error(String((error as Error).stack ?? error));
  process.exit(1);
});
