import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { t } from "../i18n";
import {
  classifyUpdate,
  fetchLatestVersion,
  INSTALLER_URL,
  VERSION,
  type LatestVersionResult,
  type LatestVersionSource,
  type UpdateKind,
} from "./versionCheck";

/**
 * Update workflow helpers shared by the three launch modes (TUI, console,
 * daemon) and the one-shot `update` command.
 *
 * Version discovery stays offline by default: a stock build never phones
 * home. The caller may supply a remote latest-version source (e.g. a packaged
 * build pointed at its own distribution channel); development mode (-dev)
 * reads a local `version` file instead (see updater/versionCheck).
 *
 * Applying an update follows the installation model used by the official
 * installers:
 * - when the running binary lives in the canonical install directory, the
 *   same installer command that placed it there is re-run in the background;
 *   it replaces the binary while user data (EDX_DATA, wallet files, config)
 *   is preserved, and the wallet process should exit right after launching it;
 * - otherwise no self-replacement is possible, so the release page URL is
 *   offered for a manual download instead.
 */

/** Latest-version probe plus the update classification of the current VERSION. */
export interface UpdateCheckResult {
  latest: LatestVersionResult | null;
  kind: UpdateKind;
}

/** Resolve the latest version and classify it against VERSION. Never throws:
 *  a failed lookup yields { latest: null, kind: "none" }. */
export async function checkAndClassify(
  dev: boolean,
  source?: LatestVersionSource,
  cwd: string = process.cwd(),
): Promise<UpdateCheckResult> {
  try {
    const latest = await fetchLatestVersion(dev, source ?? undefined, cwd);
    if (!latest) return { latest: null, kind: "none" };
    return { latest, kind: classifyUpdate(VERSION, latest.version).kind };
  } catch {
    return { latest: null, kind: "none" };
  }
}

/**
 * Canonical installation directory of the official installers:
 * - win32: %LOCALAPPDATA%\dexcoin
 * - darwin/linux: $HOME/.dexcoin/bin
 * null when the platform is unsupported or a required environment variable is
 * missing (the install location cannot be determined).
 */
export function installerInstallDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) return null;
    return path.join(localAppData, "dexcoin");
  }
  if (platform === "darwin" || platform === "linux") {
    return path.join(os.homedir(), ".dexcoin", "bin");
  }
  return null;
}

/** Lower-case, trailing-separator-stripped path for directory comparisons. */
function normalizeDir(dir: string, platform: NodeJS.Platform): string {
  let normalized = dir.replace(/[\\/]+$/, "");
  if (platform === "win32") normalized = normalized.replace(/\//g, "\\").toLowerCase();
  return normalized;
}

/**
 * Whether the running program was installed by the official installers:
 * the process is a real binary (not the bun development runner) located under
 * the canonical install directory.
 */
export function isInstalledByInstaller(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const installDir = installerInstallDir(platform, env);
  if (!installDir) return false;
  const exeName = path.basename(execPath).toLowerCase();
  if (exeName === "bun" || exeName === "bun.exe") return false;
  return normalizeDir(path.dirname(execPath), platform) === normalizeDir(installDir, platform);
}

/**
 * Command that re-runs the official installer, per platform:
 * - win32: powershell -NoProfile -Command "irm <INSTALLER_URL> | iex"
 * - darwin/linux: bash -c "curl -fsSL <URL> | bash || wget -qO- <URL> | bash"
 * null on unsupported platforms (nothing to run).
 */
export function installerCommand(platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === "win32") {
    return ["powershell", "-NoProfile", "-Command", `irm ${INSTALLER_URL} | iex`];
  }
  if (platform === "darwin" || platform === "linux") {
    return ["bash", "-c", `curl -fsSL ${INSTALLER_URL} | bash || wget -qO- ${INSTALLER_URL} | bash`];
  }
  return null;
}

/**
 * Launch the official installer detached from the current process so it
 * survives the wallet exiting and finishes replacing the binary. Failures are
 * silent: the caller keeps a manual-download hint as the fallback.
 */
export function runInstaller(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const argv = installerCommand(platform);
  if (!argv) return;
  try {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: env as NodeJS.ProcessEnv,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Spawn failure is non-fatal; the caller falls back to the download hint.
  }
}

/** Classification result for display. */
export type UpdateNoticeKind = "none" | "available";

/** Compose the one-line update notice for a given launch mode, or null when
 *  there is nothing to report. The copy goes through i18n. */
export function modeUpdateNotice(
  mode: "tui" | "console" | "daemon",
  result: UpdateCheckResult,
): string | null {
  if (result.kind === "none" || !result.latest) return null;
  const { version } = result.latest;
  if (mode === "daemon") return t("update.daemonNotice", { cur: VERSION, latest: version });
  if (mode === "console") return t("update.cliNotice", { cur: VERSION, latest: version });
  // TUI notice is informational and non-blocking; the update command performs
  // the actual upgrade.
  return t("update.cliNotice", { cur: VERSION, latest: version });
}

/** Dependencies of the `update` command action, injectable for tests. */
export interface ApplyUpdateDeps {
  /** Latest-version probe used when not in dev mode. */
  source?: LatestVersionSource;
  /** Whether the running program was installed by the official installer. */
  isInstalled?: () => boolean;
  /** Re-run the official installer in the background. */
  install?: () => void;
}

/**
 * The `update` command body, shared by the console/TUI command line and the
 * one-shot `edgex-wallet update` entry.
 *
 * - No update available -> "already up to date".
 * - Update available and the program is installer-managed -> launch the
 *   installer in the background and ask the caller to stop the wallet so the
 *   replacement can finish.
 * - Otherwise -> offer the release page for a manual download.
 *
 * Returns the message the caller should print. The caller decides whether to
 * actually stop the running wallet after an auto-install was started.
 */
export async function applyUpdate(
  opts: { dev: boolean; cwd?: string },
  deps: ApplyUpdateDeps = {},
): Promise<{ text: string; installing: boolean; latestUrl?: string }> {
  const { dev, cwd } = opts;
  const isInstalled = deps.isInstalled ?? (() => isInstalledByInstaller());
  const install = deps.install ?? (() => runInstaller());
  const result = await checkAndClassify(dev, deps.source, cwd);
  if (result.kind === "none" || !result.latest) {
    return { text: t("update.upToDate", { v: VERSION }), installing: false };
  }
  const { version, url } = result.latest;
  if (isInstalled()) {
    install();
    return { text: t("update.autoInstalling", { cur: VERSION, latest: version }), installing: true };
  }
  return { text: t("update.downloadHint", { url }), installing: false, latestUrl: url };
}
