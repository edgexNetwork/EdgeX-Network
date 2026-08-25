import { spawn } from "node:child_process";
import { t } from "../i18n";
import type { Logger } from "../utils/log";


export const WINDOWS_TERMINAL_STORE_URL = "https://apps.microsoft.com/detail/9N0DX20HK701";

export const WINDOWS_TERMINAL_STORE_URI = "ms-windows-store://pdp/?ProductId=9N0DX20HK701";


export type TuiEnvIssue = { code: "term-dumb" } | { code: "win-legacy-console" };


const MODERN_TERMINAL_MARKERS = [
  "WT_SESSION",
  "WT_PROFILE_ID",
  "ConEmuANSI",
  "ConEmuPID",
  "TERM_PROGRAM",
  "TERMINAL_EMULATOR",
  "ALACRITTY_LOG",
  "ITERM_PROFILE",
  "VSCODE_PID",
] as const;







export function assessTuiEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TuiEnvIssue[] {
  const issues: TuiEnvIssue[] = [];
  if (env.TERM === "dumb") issues.push({ code: "term-dumb" });
  if (platform === "win32") {
    const term = env.TERM ?? "";
    const modern =
      MODERN_TERMINAL_MARKERS.some((key) => env[key]) ||
      term.startsWith("xterm") ||
      term.startsWith("screen");
    if (!modern) issues.push({ code: "win-legacy-console" });
  }
  return issues;
}


export function isTuiEnvForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EDX_TUI_FORCE === "1";
}


function promptTuiChoice(promptText: string): Promise<"continue" | "open-store"> {
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onSigint = () => process.exit(130);
    rl.on("SIGINT", onSigint);
    rl.question(promptText, (answer) => {
      rl.off("SIGINT", onSigint);
      rl.close();
      resolve(answer.trim().toLowerCase() === "o" ? "open-store" : "continue");
    });
  });
}


function openWindowsTerminalStore(): void {
  try {
    const child = spawn("cmd", ["/c", "start", "", WINDOWS_TERMINAL_STORE_URI], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {

  }
}







export async function warnAndPromptTuiEnv(log: Logger): Promise<void> {
  const issues = assessTuiEnv();
  if (issues.length === 0) return;
  if (isTuiEnvForced()) {
    log.warn(t("env.forceSkipped"));
    return;
  }
  log.warn(`TUI environment issues: ${issues.map((i) => i.code).join(", ")}`);
  const lines: string[] = ["", t("env.title")];
  for (const issue of issues) {
    lines.push(issue.code === "term-dumb" ? t("env.termDumb") : t("env.winLegacy"));
  }
  const onWindows = issues.some((i) => i.code === "win-legacy-console");
  if (onWindows) {
    lines.push(t("env.winStore"));
    lines.push(t("env.openStore"));
  }
  lines.push(t("env.continue"));
  process.stdout.write(lines.join("\n") + "\n");
  const choice = await promptTuiChoice("  > ");
  if (choice === "open-store" && onWindows) openWindowsTerminalStore();
}
