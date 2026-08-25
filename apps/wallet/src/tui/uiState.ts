import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { UiMode } from "./views";
import { UI_STATE_FILE_NAME } from "../i18n";
import { readGlobalData, writeGlobalData } from "../core/globalData";

export { UI_STATE_FILE_NAME };






export function loadUiMode(datadir: string): UiMode | null {
  try {
    const stored = readGlobalData("ui.mode");
    if (stored === "command" || stored === "mouse") return stored;
    const legacyPath = path.join(datadir, UI_STATE_FILE_NAME);
    if (!existsSync(legacyPath)) return null;
    const raw = JSON.parse(readFileSync(legacyPath, "utf8")) as { mode?: unknown };
    if (raw?.mode !== "command" && raw?.mode !== "mouse") return null;
    writeGlobalData("ui.mode", raw.mode);
    return raw.mode;
  } catch {
    return null;
  }
}

export function saveUiMode(datadir: string, mode: UiMode): void {
  try {
    void datadir;
    writeGlobalData("ui.mode", mode);
  } catch {

  }
}
