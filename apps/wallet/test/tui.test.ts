import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANG_ORDER,
  assertCompleteDictionaries,
  detectLang,
  loadLang,
  nextLang,
  saveLang,
  setLang,
  t,
} from "../src/i18n";
import { TABS, buildCommandView, buildView, emptySendDraft, modeButtonLabel, tabLabel } from "../src/tui/views";
import type { ChainInfoView, FeeTiers, TxView } from "../src/api/types";
import { reduceInput } from "../src/tui/inputReducer";
import type { InputState } from "../src/tui/inputReducer";
import { hitLangButton, hitModeButton, hitTabRow } from "../src/tui/mouseHit";
import { onboardingFocusOrder, stepOnboardFocus } from "../src/tui/Onboarding";
import { strWidth } from "../src/utils/display";
import { initGlobalData } from "../src/core/globalData";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "edgex-tui-"));
initGlobalData(temporaryDirectory);

function chainInfo(): ChainInfoView {
  return {
    chain: "edx",
    blocks: 12,
    latestHash: "a".repeat(64),
    backendHeight: 12,
    syncProgress: 1,
    localHeight: 12,
    syncStatus: "synced",
    syncError: null,
    lastBlockTime: 1_800_000_000,
    phase: 1,
    blockReward: "400",
    supply: "4800",
    networkPower: 0,
    pendingCount: 0,
    connectedNodes: 1,
  };
}

function inputState(overrides: Partial<InputState> = {}): InputState {
  return {
    focus: "command",
    row: 0,
    command: "",
    cmdHistory: [],
    cmdIndex: null,
    draft: emptySendDraft(),
    dialogOpen: false,
    scroll: 0,
    requirePassword: true,
    mode: "command",
    view: "balance",
    dialogSel: "confirm",
    dialogOptions: 0,
    dialogOptionSel: 0,
    askActive: false,
    ...overrides,
  };
}

describe("legacy-compatible i18n", () => {
  test("keeps zh/en/ru/ja dictionaries on the exact same key set", () => {
    expect(() => assertCompleteDictionaries()).not.toThrow();
    expect(LANG_ORDER).toEqual(["zh", "en", "ru", "ja"]);
  });

  test("detects and persists languages", () => {
    expect(detectLang({ LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(detectLang({ LC_ALL: "ru_RU" })).toBe("ru");
    saveLang(temporaryDirectory, "en");
    expect(loadLang(temporaryDirectory)).toBe("en");
    expect(nextLang("zh")).toBe("en");
    expect(t("tab.balance")).toBe("余额");
    setLang("en");
    expect(t("tab.balance")).toBe("Balance");
    setLang("zh");
  });
});

describe("legacy TUI structure", () => {
  const fees: FeeTiers = { slow: "0.01", normal: "0.05", fast: "0.1", recommended: "normal", pendingCount: 0 };
  const snapshot = {
    chain: chainInfo(),
    balance: "100.00000000",
    fees,
    txs: [] as TxView[],
    connectedNodes: 1,
    totalNodes: 2,
    draft: emptySendDraft(),
    focus: "command" as const,
    focusRow: 0,
    chainBalance: "100.00000000",
    reservedBalance: "0.00000000",
    immatureBalance: "0.00000000",
    sendBusy: false,
    sendResult: null,
    logs: [],
    scroll: 0,
    cols: 100,
    mainH: 20,
    address: "EDXADDRESS",
    selfP2pUrl: "",
    requirePassword: true,
    peersText: "",
    qr: ["###"],
    copyMsg: null,
  };
  const actions = {
    refresh: () => {},
    copyAddress: () => {},
    copyTxid: () => {},
    navigate: () => {},
    focusField: () => {},
    setTier: () => {},
    submitSend: () => {},
    resetSend: () => {},
    addRow: () => {},
    delRow: () => {},
    showTx: () => {},
    reconnect: () => {},
    scrollBy: () => {},
  };

  test("preserves seven tabs, dual-mode button, and localized labels", () => {
    expect(TABS.map((tab) => tab.name)).toEqual(["balance", "send", "receive", "history", "network", "fees", "logs"]);
    expect(tabLabel("balance")).toBe("01 余额");
    expect(modeButtonLabel("mouse")).toBe("[切换: 命令 Ctrl+B]");
  });

  test("builds every visual view with bounded rows", () => {
    for (const view of TABS.map((tab) => tab.name)) {
      const result = buildView(view, snapshot as never, actions);
      expect(result.rows.length).toBeGreaterThan(0);
      result.rows.forEach((row) => expect(row.text).toBeDefined());
    }
  });

  test("merges command sessions and logs in command mode", () => {
    const result = buildCommandView(
      [{ id: 1, line: "info", output: ["height=12"], ts: 20 }],
      [{ ts: 10, level: "info", message: "started" }],
      0,
      12,
      80,
    );
    expect(result.rows.map((row) => row.text)).toEqual([
      "[00:00:00] [INFO] started",
      "> info",
      "height=12",
    ]);
  });
});

describe("keyboard, mouse, and onboarding parity", () => {
  test("routes command entry, history navigation, and send focus", () => {
    const typed = reduceInput(inputState(), "fees", {});
    expect(typed.state.command).toBe("fees");
    const submitted = reduceInput(typed.state, "", { return: true });
    expect(submitted.effect).toEqual({ kind: "runCommand", line: "fees" });
    expect(submitted.state.cmdHistory).toEqual(["fees"]);

    const historyState = inputState({ cmdHistory: ["info"], cmdIndex: null });
    const previous = reduceInput(historyState, "", { upArrow: true });
    expect(previous.state.command).toBe("info");

    const sendState = inputState({ mode: "mouse", view: "send" });
    const focusedSend = reduceInput(sendState, "", { return: true });
    expect(focusedSend.effect).toEqual({ kind: "none" });
    expect(focusedSend.state.focus).toBe("to");
  });

  test("hits tabs and top-bar buttons at the same coordinates as rendering", () => {
    const tabs = TABS.map((tab) => ({ name: tab.name, label: tabLabel(tab.name) }));
    expect(hitTabRow(tabs, 0, 3, 3)?.name).toBe("balance");
    expect(hitModeButton(100, modeButtonLabel("mouse"), 99, 1)).toBe(true);
    const languageLabel = "[РУС]";
    const commandLabel = modeButtonLabel("mouse");
    const languageX = 100 - strWidth(commandLabel) - 1 - strWidth(languageLabel);
    expect(hitLangButton(100, languageLabel, commandLabel, languageX, 1)).toBe(true);
  });

  test("keeps onboarding field order and cyclic stepping", () => {
    expect(onboardingFocusOrder("import", false)).toEqual(["mode", "mnemonic", "password", "confirm"]);
    expect(stepOnboardFocus("confirm", onboardingFocusOrder("create", false), 1)).toBe("mode");
  });
});
