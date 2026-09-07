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
import { runConsoleWithReadline } from "./cli/consoleSession";
import { runCliOnboarding, OnboardCancelledError } from "./cli/onboardPrompt";
import { VERSION } from "./updater/versionCheck";
import { checkAndClassify, modeUpdateNotice, applyUpdate } from "./updater/updateActions";
import { helpText } from "./cli/helpText";

function printHelp(): void {
  console.log(helpText());
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

async function loadExistingWallet(
  config: WalletConfig,
  log: Logger,
  opts: { password?: string } = {},
): Promise<{ key: WalletKey; password: string }> {
  try {
    return await loadWalletWithRetry(config.datadir, { password: opts.password });
  } catch (error) {
    const message = (error as Error).message;
    log.error(`Wallet load failed: ${message}`);
    console.error(`Wallet load failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Plain-text first-run onboarding for the console and daemon entry points.
 * - Interactive terminal: run the create/import walkthrough; a user cancel
 *   exits cleanly (code 0), a hard failure logs and exits 1.
 * - Non-interactive terminal: returns null so the caller keeps its
 *   "run init first" error path.
 */
async function runCliOnboardingSafe(
  config: WalletConfig,
  log: Logger,
): Promise<{ key: WalletKey; password: string; created: boolean } | null> {
  try {
    return await runCliOnboarding({ datadir: config.datadir });
  } catch (error) {
    if (error instanceof OnboardCancelledError) process.exit(0);
    const message = (error as Error).message;
    log.error(`Wallet setup failed: ${message}`);
    console.error(`Wallet setup failed: ${message}`);
    process.exit(1);
  }
}

/**
 * One silent background update check per launch, keyed by mode so the notice
 * wording matches the surface it is shown on (daemon log line / console
 * message / TUI logs tab). Failures are swallowed: an offline or broken
 * version source never blocks startup.
 */
function notifyUpdateOnce(log: Logger, mode: "tui" | "console" | "daemon", dev: boolean): void {
  void checkAndClassify(dev).then((result) => {
    const notice = modeUpdateNotice(mode, result);
    if (notice) log.warn(notice);
  });
}

async function startWallet(paths: CliPaths, tui: boolean): Promise<void> {
  const { config, warnings } = resolveConfig(paths);
  mkdirSync(config.datadir, { recursive: true });
  initGlobalData();
  applyStoredLang(config.datadir);
  // The TUI and the interactive console keep their log lines off the shared
  // console output (the console session prints its own transcript and redraws
  // the prompt around in-band log lines). The daemon logs straight to the
  // console only when it runs in a foreground terminal; when its stdout is a
  // pipe (service manager / redirection) the console stays clean and lines go
  // to dexcoin.log only.
  const interactiveTerminal = Boolean(process.stdout.isTTY);
  const log = new Logger({
    console: !tui && interactiveTerminal,
    file: path.join(config.datadir, "dexcoin.log"),
  });
  warnings.forEach((warning) => log.warn(warning));
  if (tui && interactiveTerminal) await warnAndPromptTuiEnv(log);

  let key: WalletKey;
  let password: string | undefined;
  let created = false;
  if (!hasWalletFile(config.datadir)) {
    // A startup password supplied on the command line or via the environment
    // means the caller expects an existing wallet (scripted/service start);
    // in that case do not prompt - fail with a clear init hint instead.
    const scripted = paths.password !== undefined || process.env.EDX_WALLET_PASSWORD !== undefined;
    if (tui && interactiveTerminal) {
      const result = await runOnboarding(config, log);
      key = result.key;
      created = result.created;
    } else if (process.stdin.isTTY && interactiveTerminal && !scripted) {
      // Console/daemon interactive first run: text-mode onboarding. When the
      // run is non-interactive runCliOnboardingSafe returns null below.
      const onboarded = await runCliOnboardingSafe(config, log);
      if (onboarded === null) {
        console.error(`Wallet not initialized: ${vaultFilePath(config.datadir)} missing; run \`edgex-wallet init\` first`);
        process.exit(1);
      }
      key = onboarded.key;
      password = onboarded.password;
      created = onboarded.created;
    } else {
      console.error(`Wallet not initialized: ${vaultFilePath(config.datadir)} missing; run \`edgex-wallet init\` first`);
      process.exit(1);
    }
  } else {
    const loaded = await loadExistingWallet(config, log, { password: paths.password });
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

  if (!tui || !interactiveTerminal) {
    // daemon mode: one silent background update check, logged as a line.
    notifyUpdateOnce(log, "daemon", Boolean(paths.dev));
    log.info(t("log.daemonRunning", { summary: serviceSummary(config), nodes: joinNodes(config.addnodes) }));
    return;
  }

  process.stdout.write("\x1b[2J\x1b[H");
  const application = render(
    <App core={core} log={log} registry={registry} config={config} dev={Boolean(paths.dev)} onExit={exit} />,
    {
      exitOnCtrlC: false,
    },
  );
  log.info(t("log.tuiStarted", { summary: serviceSummary(config), nodes: joinNodes(config.addnodes) }));
  // TUI mode: one silent background update check; the notice lands in the logs
  // tab through the App's log sink.
  notifyUpdateOnce(log, "tui", Boolean(paths.dev));
  core.bus.on("shutdown", () => application.unmount());
}

async function startConsole(paths: CliPaths): Promise<void> {
  const { config, warnings } = resolveConfig(paths);
  mkdirSync(config.datadir, { recursive: true });
  initGlobalData();
  applyStoredLang(config.datadir);
  // Keep log lines off the shared console output: the session prints its own
  // transcript and re-renders the prompt around in-band log lines.
  const log = new Logger({ console: false, file: path.join(config.datadir, "dexcoin.log") });
  warnings.forEach((warning) => log.warn(warning));
  if (!hasWalletFile(config.datadir)) {
    const scripted = paths.password !== undefined || process.env.EDX_WALLET_PASSWORD !== undefined;
    if (process.stdin.isTTY && process.stdout.isTTY && !scripted) {
      // Interactive console first run: plain-text onboarding instead of a bare
      // "run init first" error. A null result means the run is not interactive
      // after all, or the user cancelled - fall through to the error path.
      const onboarded = await runCliOnboardingSafe(config, log);
      if (onboarded !== null) {
        const result = onboarded;
        await continueConsole(config, paths, log, result.key, result.password, result.created);
        return;
      }
    }
    console.error(`Wallet not initialized: ${vaultFilePath(config.datadir)} missing; run \`edgex-wallet init\` first`);
    process.exit(1);
  }
  const loaded = await loadExistingWallet(config, log, { password: paths.password });
  await continueConsole(config, paths, log, loaded.key, loaded.password, false);
}

/** Shared console-session bring-up for an existing (or freshly onboarded)
 *  wallet: build services, start them, then run the line session. */
async function continueConsole(
  config: WalletConfig,
  paths: CliPaths,
  log: Logger,
  key: WalletKey,
  password: string,
  created: boolean,
): Promise<void> {
  if (created) log.warn(t("log.walletCreated", { address: key.address }));
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
  process.on("SIGTERM", exit);

  const commandContext = {
    core,
    log,
    interactive: true,
    password,
    datadir: config.datadir,
    dev: Boolean(paths.dev),
  };
  log.info(t("log.consoleStarted", { summary: serviceSummary(config) }));
  // console mode: one silent background update check, presented through the
  // session's log presenter.
  notifyUpdateOnce(log, "console", Boolean(paths.dev));
  await runConsoleWithReadline(registry, commandContext, log, {
    write: (line) => console.log(line),
    prompt: "edx> ",
    onExit: exit,
  });
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

/**
 * One-shot `edgex-wallet update`: check for an update and apply it.
 * Deliberately does not require a wallet - updating the program is unrelated
 * to wallet data and must work before `init` has ever run. The installer is
 * re-run in the background for installer-managed builds; otherwise the release
 * page is printed for a manual download.
 */
async function runUpdateOneShot(paths: CliPaths): Promise<void> {
  const outcome = await applyUpdate({ dev: Boolean(paths.dev), cwd: process.cwd() });
  console.log(outcome.text);
  if (outcome.installing) {
    // Give the background installer a moment to detach, then leave.
    setTimeout(() => process.exit(0), 500);
  }
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
  const loaded = await loadExistingWallet(config, log, { password: paths.password });
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
  if (command === "console" || command === "cli") return startConsole(paths);
  if (command === "init") return initWallet(paths, args);
  // update/upgrade never need a wallet: dispatch before the one-shot wallet
  // guard so an uninitialized data directory can still update the program.
  if (command === "update" || command === "upgrade") return runUpdateOneShot(paths);
  return runOneShot(command, args, paths);
}

main().catch((error) => {
  console.error(String((error as Error).stack ?? error));
  process.exit(1);
});
