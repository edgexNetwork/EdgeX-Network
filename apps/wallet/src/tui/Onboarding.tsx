import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { createOrLoadKey, type WalletKey } from "../keys/walletKeyClean";
import { hasLegacyMnemonic } from "../keys/vaultLegacy";
import { isValidMnemonic } from "../keys/mnemonic";
import type { Logger } from "../utils/log";
import { applyStoredLang, LANG_BUTTON_LABEL, nextLang, saveLang, setLang, t, type Lang } from "../i18n";
import { C } from "./theme";

export interface OnboardingProps {
  datadir: string;
  log: Logger;
  onDone: (key: WalletKey, created: boolean) => void;
  onExit: () => void;
}

export type OnboardMode = "create" | "import";
export type OnboardFocus = "mode" | "mnemonic" | "password" | "confirm";


export function onboardingFocusOrder(mode: OnboardMode, legacy: boolean): OnboardFocus[] {
  if (legacy) return ["password", "confirm"];
  return mode === "import" ? ["mode", "mnemonic", "password", "confirm"] : ["mode", "password", "confirm"];
}


export function stepOnboardFocus(current: OnboardFocus, order: OnboardFocus[], dir: 1 | -1): OnboardFocus {
  const idx = order.indexOf(current);
  if (idx < 0) return order[0] ?? "password";
  return order[(idx + dir + order.length) % order.length];
}

const FIELD_CTL = /[\x00-\x08\x0e-\x1f\x7f]/;


function masked(value: string, focused: boolean): string {
  if (value === "") return focused ? "▌" : "";
  return "*".repeat(value.length) + (focused ? "▌" : "");
}






export function Onboarding({ datadir, log, onDone, onExit }: OnboardingProps) {
  const legacy = hasLegacyMnemonic(datadir);
  const [mode, setMode] = useState<OnboardMode>(legacy ? "create" : "create");
  const [focus, setFocus] = useState<OnboardFocus>(legacy ? "password" : "mode");
  const [mnemonic, setMnemonic] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [backupKey, setBackupKey] = useState<WalletKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [lang, setLangState] = useState<Lang>(() => applyStoredLang(datadir));

  const submit = () => {
    setError(null);
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (mode === "import" && !isValidMnemonic(mnemonic)) {
      setError("Invalid BIP39 mnemonic; check the words and spelling");
      return;
    }
    setBusy(true);
    try {
      const result = createOrLoadKey(datadir, {
        password,
        mnemonic: mode === "import" ? mnemonic : undefined,
        context: "onboarding",
      });
      if (result.migrated) {
        log.info(t("log.onboardMigrated"));
      } else if (result.created) {
        log.info(t("log.onboardCreated"));
      }
      if (result.created) {
        setBackupKey(result.key);
      } else {
        onDone(result.key, result.created);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const toggleLang = () => {
    const next = nextLang(lang);
    setLang(next);
    setLangState(next);
    saveLang(datadir, next);
  };

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      onExit();
      return;
    }

    if (key.ctrl && input.toLowerCase() === "l") {
      toggleLang();
      return;
    }

    if (backupKey) {
      if (key.return || key.tab) onDone(backupKey, true);
      return;
    }
    if (busy) return;
    if (key.escape) {
      setError(null);
      return;
    }

    const focusOrder = onboardingFocusOrder(mode, legacy);

    if ((key.tab && key.shift) || key.upArrow) {
      setError(null);
      setFocus(stepOnboardFocus(focus, focusOrder, -1));
      return;
    }

    if (key.tab || key.downArrow) {
      setError(null);
      setFocus(stepOnboardFocus(focus, focusOrder, 1));
      return;
    }

    if (key.return) {
      if (focus === focusOrder[focusOrder.length - 1]) {
        submit();
      } else {
        setError(null);
        setFocus(stepOnboardFocus(focus, focusOrder, 1));
      }
      return;
    }
    if (focus === "mode") {
      if (input === "1") setMode("create");
      else if (input === "2") setMode("import");
      return;
    }
    if (key.backspace || key.delete) {
      if (focus === "mnemonic") setMnemonic((v) => v.slice(0, -1));
      else if (focus === "password") setPassword((v) => v.slice(0, -1));
      else if (focus === "confirm") setConfirm((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !FIELD_CTL.test(input)) {
      if (focus === "mnemonic") setMnemonic((v) => (v + input).slice(0, 500));
      else if (focus === "password") setPassword((v) => (v + input).slice(0, 64));
      else if (focus === "confirm") setConfirm((v) => (v + input).slice(0, 64));
    }
  });

  if (backupKey) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={C.fg}>{t("onboard.backupTitle")}</Text>
        <Text color={C.gray}>{t("onboard.backupHint")}</Text>
        <Box marginTop={1} borderStyle="round" borderColor={C.fg} flexDirection="column" paddingX={1}>
          <Text color={C.amber} bold>{t("onboard.backupWarn")}</Text>
          <Box marginTop={1}>
            <Text color={C.fg} bold>{backupKey.mnemonic}</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={C.grayDim}>{`${t("ui.address")}: `}</Text>
          <Text color={C.cyan}>{backupKey.address}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={C.grayDim}>{t("onboard.walletFile")}</Text>
          <Text color={C.white}>{`${datadir}${"\\"}wallet.vault`}{t("onboard.binaryEncrypted")}</Text>
        </Box>
        <Box marginTop={2}>
          <Text bold color={C.fg}>{t("onboard.enterToContinue")}</Text>
        </Box>
      </Box>
    );
  }

  const modeRow = legacy ? null : (
    <Box>
      <Text color={C.grayDim}>{t("onboard.mode")}</Text>
      <Text color={mode === "create" ? C.fg : C.gray} bold={mode === "create"}>
        {mode === "create" ? `[1] ${t("onboard.create")}` : ` 1  ${t("onboard.create")}`}
      </Text>
      <Text> </Text>
      <Text color={mode === "import" ? C.fg : C.gray} bold={mode === "import"}>
        {mode === "import" ? `[2] ${t("onboard.import")}` : ` 2  ${t("onboard.import")}`}
      </Text>
      {focus === "mode" && <Text color={C.cyan}>{t("onboard.press12")}</Text>}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={C.fg}>{t("onboard.title")}</Text>
      <Text color={C.gray}>{t("onboard.datadir", { dir: datadir })}</Text>
      {legacy && (
        <Text color={C.amber}>{t("onboard.legacyWarn")}</Text>
      )}
      <Box marginTop={1}>{modeRow}</Box>
      {mode === "import" && (
        <Box>
          <Text color={C.grayDim}>{t("onboard.mnemonic")}</Text>
          <Text color={focus === "mnemonic" ? C.cyan : C.white}>
            {mnemonic === "" ? (focus === "mnemonic" ? "▌" : t("onboard.mnemonicPlaceholder")) : mnemonic + (focus === "mnemonic" ? "▌" : "")}
          </Text>
        </Box>
      )}
      <Box>
        <Text color={C.grayDim}>{t("onboard.password")}</Text>
        <Text color={focus === "password" ? C.cyan : C.white}>[{masked(password, focus === "password")}]</Text>
      </Box>
      <Box>
        <Text color={C.grayDim}>{t("onboard.confirmPassword")}</Text>
        <Text color={focus === "confirm" ? C.cyan : C.white}>[{masked(confirm, focus === "confirm")}]</Text>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={C.red}>Error: {error}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={C.gray}>{t("onboard.hint")}</Text>
          <Text color={C.grayDim}>{LANG_BUTTON_LABEL[lang]} {t("onboard.langHint")}</Text>
        </Box>
      )}
    </Box>
  );
}
