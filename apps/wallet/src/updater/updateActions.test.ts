import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { setLang, t } from "../i18n";
import { LOCAL_VERSION_FILE, VERSION } from "./versionCheck";
import {
  applyUpdate,
  checkAndClassify,
  installerCommand,
  installerInstallDir,
  isInstalledByInstaller,
  modeUpdateNotice,
} from "./updateActions";

setLang("zh");

describe("checkAndClassify", () => {
  test("dev mode reads the local version file and classifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-update-"));
    try {
      writeFileSync(join(dir, LOCAL_VERSION_FILE), "9.9.9");
      const result = await checkAndClassify(true, undefined, dir);
      expect(result.latest).not.toBeNull();
      expect(result.kind).toBe("major");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dev mode without a version file reports no update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-update-"));
    try {
      const result = await checkAndClassify(true, undefined, dir);
      expect(result).toEqual({ latest: null, kind: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production mode stays offline without a remote source", async () => {
    const result = await checkAndClassify(false);
    expect(result).toEqual({ latest: null, kind: "none" });
  });

  test("production mode uses a supplied remote source", async () => {
    const source = async () => ({ version: "v9.9.9", url: "https://example.invalid/releases" });
    const result = await checkAndClassify(false, source);
    expect(result.kind).toBe("major");
    expect(result.latest!.url).toBe("https://example.invalid/releases");
  });

  test("never throws when the source fails", async () => {
    const source = async () => {
      throw new Error("offline");
    };
    const result = await checkAndClassify(false, source);
    expect(result).toEqual({ latest: null, kind: "none" });
  });
});

describe("installerInstallDir", () => {
  test("resolves the Windows install dir from LOCALAPPDATA", () => {
    const dir = installerInstallDir("win32", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" });
    expect(dir).toBe("C:\\Users\\alice\\AppData\\Local\\dexcoin");
  });

  test("returns null on Windows without LOCALAPPDATA", () => {
    expect(installerInstallDir("win32", {})).toBeNull();
  });

  test("resolves the POSIX install dir under the home directory", () => {
    const dir = installerInstallDir("linux", { HOME: "/home/alice" });
    // The home directory comes from the OS user profile (os.homedir), which on
    // POSIX reflects $HOME; assert against that so the test passes on any host.
    expect(dir).toBe(join(os.homedir(), ".dexcoin", "bin"));
  });

  test("returns null on unsupported platforms", () => {
    expect(installerInstallDir("freebsd" as NodeJS.Platform, {})).toBeNull();
  });
});

describe("isInstalledByInstaller", () => {
  test("detects a binary in the canonical Windows dir", () => {
    const execPath = "C:\\Users\\alice\\AppData\\Local\\dexcoin\\dexcoin.exe";
    expect(isInstalledByInstaller(execPath, "win32", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).toBe(true);
  });

  test("rejects the bun development runner", () => {
    const execPath = "/usr/local/bin/bun";
    expect(isInstalledByInstaller(execPath, "linux", { HOME: "/home/alice" })).toBe(false);
  });

  test("rejects a binary outside the canonical dir", () => {
    const execPath = "/home/alice/dist/dexcoin";
    expect(isInstalledByInstaller(execPath, "linux", { HOME: "/home/alice" })).toBe(false);
  });
});

describe("installerCommand", () => {
  test("builds the Windows one-liner", () => {
    expect(installerCommand("win32")).toEqual([
      "powershell",
      "-NoProfile",
      "-Command",
      "irm https://install.edgexnetwork.org | iex",
    ]);
  });

  test("builds the POSIX one-liner with curl then wget fallback", () => {
    const command = installerCommand("linux");
    expect(command![0]).toBe("bash");
    expect(command![1]).toBe("-c");
    expect(command![2]).toContain("curl -fsSL https://install.edgexnetwork.org | bash");
    expect(command![2]).toContain("wget -qO- https://install.edgexnetwork.org | bash");
  });

  test("returns null on unsupported platforms", () => {
    expect(installerCommand("freebsd" as NodeJS.Platform)).toBeNull();
  });
});

describe("modeUpdateNotice", () => {
  const available = { latest: { version: "v9.9.9", url: "https://example.invalid" }, kind: "major" as const };
  const upToDate = { latest: null, kind: "none" as const };

  test("returns null when there is no update", () => {
    expect(modeUpdateNotice("daemon", upToDate)).toBeNull();
    expect(modeUpdateNotice("console", upToDate)).toBeNull();
    expect(modeUpdateNotice("tui", upToDate)).toBeNull();
  });

  test("daemon notice points at the update command", () => {
    const notice = modeUpdateNotice("daemon", available);
    expect(notice).toContain(t("update.daemonNotice", { cur: VERSION, latest: "v9.9.9" }));
  });

  test("console and TUI notices suggest typing update", () => {
    const consoleNotice = modeUpdateNotice("console", available);
    expect(consoleNotice).toContain(t("update.cliNotice", { cur: VERSION, latest: "v9.9.9" }));
    expect(modeUpdateNotice("tui", available)).toBe(consoleNotice);
  });
});

describe("applyUpdate", () => {
  const source = async () => ({ version: "v9.9.9", url: "https://example.invalid/releases" });

  test("reports up to date when no update is available", async () => {
    const outcome = await applyUpdate({ dev: false, cwd: process.cwd() });
    expect(outcome.installing).toBe(false);
    expect(outcome.text).toContain(t("update.upToDate", { v: VERSION }));
  });

  test("offers the download page when not installer-managed", async () => {
    const outcome = await applyUpdate({ dev: false }, { source, isInstalled: () => false, install: () => {} });
    expect(outcome.installing).toBe(false);
    expect(outcome.latestUrl).toBe("https://example.invalid/releases");
    expect(outcome.text).toContain("https://example.invalid/releases");
  });

  test("auto-installs in the background when installer-managed", async () => {
    let installed = false;
    const outcome = await applyUpdate({ dev: false }, { source, isInstalled: () => true, install: () => { installed = true; } });
    expect(installed).toBe(true);
    expect(outcome.installing).toBe(true);
    expect(outcome.text).toContain(t("update.autoInstalling", { cur: VERSION, latest: "v9.9.9" }));
  });

  test("dev mode reads a local version file even with a source present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-update-"));
    try {
      writeFileSync(join(dir, LOCAL_VERSION_FILE), "0.0.1");
      const outcome = await applyUpdate({ dev: true, cwd: dir }, { source });
      // 0.0.1 is older than VERSION, so no update is reported and the remote
      // source is never consulted.
      expect(outcome.installing).toBe(false);
      expect(outcome.text).toContain(t("update.upToDate", { v: VERSION }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
