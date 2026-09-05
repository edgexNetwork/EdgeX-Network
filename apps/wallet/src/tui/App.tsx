import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { mouseByteState, MOUSE_DISABLE, MOUSE_ENABLE, useMouse, type MouseEventData } from "./mouse";
import { reduceInput } from "./inputReducer";
import { computeDialogLayout, hitDialog, hitLangButton, hitModeButton, hitTabRow } from "./mouseHit";
import { StatusBar } from "./StatusBar";
import { StatusFooter } from "./StatusFooter";
import { CommandLine, commandLineLines } from "./CommandLine";
import { loadUiMode, saveUiMode } from "./uiState";
import { assessTuiEnv } from "./envCheck";
import { applyStoredLang, currentLocale, LANG_BUTTON_LABEL, nextLang, saveLang, setLang, t, type Lang } from "../i18n";
import { qrLines } from "./qr";
import { copyToClipboard } from "../utils/clipboard";
import { nextDialogPassword } from "./dialogInput";
import { C } from "./theme";
import {
  buildView,
  buildCommandView,
  emptySendDraft,
  MAX_RECIPIENTS,
  modeButtonLabel,
  RECEIVE_PAGE_SIZE,
  tabLabel,
  TABS,
  type FocusTarget,
  type SendDraft,
  type SessionItem,
  type UiMode,
  type ViewName,
} from "./views";
import { strWidth, truncateMiddle, txConfirmText, txMaturityLine, txStatusLabel, txTypeLabel } from "../utils/display";
import { trimEDX, formatEDX, parseEDX } from "../utils/amount";
import { COIN_TICKER } from "../utils/constants";
import { FEE_TIER_NAMES, type FeeTierName } from "../core/fee";
import type { WalletCore } from "../core/walletCore";
import type { Logger, LogLine } from "../utils/log";
import type { AskFn, AskOption, CommandRegistry } from "../commands/registry";
import type { WalletConfig } from "../config/config";
import type {
  ChainInfoView,

  FeeTiers,
  TxView,
} from "../api/types";

const MAIN_TOP = 4;
const TAB_ROW = 3;


function cw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2329 && c <= 0x232a) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xa960 && c <= 0xa97f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe52) ||
      (c >= 0xfe54 && c <= 0xfe66) ||
      (c >= 0xfe68 && c <= 0xfe6b) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}


function fitLine(s: string, maxW: number): string {
  if (cw(s) <= maxW) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const chW = cw(ch);
    if (w + chW > maxW - 1) break;
    out += ch;
    w += chW;
  }
  return `${out}…`;
}


function computeDialogWidth(dialog: Dialog, cols: number): number {
  const titleW = cw(`► ${dialog.title}`) + cw(dialogHint(dialog));
  const linesW = dialog.lines.length > 0 ? Math.max(...dialog.lines.map((l) => cw(l))) : 0;
  const optionW = dialog.options ? Math.max(0, ...dialog.options.map((o) => cw(o.label))) : 0;
  const btnW = cw(`[${dialog.confirmText}]`) + 2 + cw(`[${dialog.cancelText ?? t("ui.cancel")}]`);
  return Math.min(Math.max(46, Math.max(titleW, linesW, optionW, btnW) + 4), Math.max(24, cols - 2));
}


function dialogHint(dialog: Dialog): string {

  if (dialog.options && dialog.options.length > 0) return t("dialog.hintNormal");
  if (dialog.hideButtons) return t("dialog.hintHidden");
  return dialog.password ? t("dialog.hintPassword") : t("dialog.hintNormal");
}

interface Dialog {
  title: string;
  lines: string[];
  confirmText: string;
  cancelText?: string;

  password?: boolean;

  options?: AskOption[];

  hideButtons?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface AppProps {
  core: WalletCore;
  log: Logger;
  registry: CommandRegistry;
  config: WalletConfig;
  onExit: () => void;
}

export function App({ core, log, registry, config, onExit }: AppProps) {
  const { stdout } = useStdout();
  const cols = Math.max(40, stdout.columns ?? 80);
  const rows = Math.max(12, stdout.rows ?? 24);

  const [view, setView] = useState<ViewName>("balance");
  const [chain, setChain] = useState<ChainInfoView | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [connectedNodes, setConnectedNodes] = useState(0);
  const [fees, setFees] = useState<FeeTiers | null>(null);
  const [txs, setTxs] = useState<TxView[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [command, setCommand] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdIndex, setCmdIndex] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusTarget>("command");
  const [focusRow, setFocusRow] = useState(0);
  const [draft, setDraft] = useState<SendDraft>(emptySendDraft());
  const [chainBalance, setChainBalance] = useState<string | null>(null);
  const [reservedBalance, setReservedBalance] = useState<string | null>(null);
  const [immatureBalance, setImmatureBalance] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogSel, setDialogSel] = useState<"confirm" | "cancel">("confirm");
  const [dialogPassword, setDialogPassword] = useState("");

  const dialogPasswordRef = useRef("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const [mouseOn, setMouseOn] = useState(true);

  const envDegraded = assessTuiEnv().length > 0;



  const [mode, setMode] = useState<UiMode>(() => (envDegraded ? "command" : loadUiMode(config.datadir) ?? "mouse"));




  const mainH = Math.max(1, rows - (mode === "command" ? 5 : 6));
  const [lang, setLangState] = useState<Lang>(() => applyStoredLang(config.datadir));
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [qr, setQr] = useState<string[] | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  // Selected receive page address (index into core.walletAddresses()).
  const [receiveIndex, setReceiveIndex] = useState(0);
  const sessionIdRef = useRef(1);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  const pendingAskRef = useRef<{ resolve: (v: string) => void } | null>(null);
  const [askMode, setAskMode] = useState<"choice" | "text" | "password" | null>(null);
  const [askPrompt, setAskPrompt] = useState("");
  const [askLines, setAskLines] = useState<string[]>([]);
  const [askOptions, setAskOptions] = useState<AskOption[]>([]);

  const [dialogOptionSel, setDialogOptionSel] = useState(0);
  const dialogOptionSelRef = useRef(0);

  const ask: AskFn = (q) =>
    new Promise<string>((resolve) => {
      pendingAskRef.current = { resolve };
      setAskPrompt(q.prompt);
      setAskLines(q.lines ?? []);
      if (q.type === "choice") {
        const opts = q.options ?? [];
        const idx = Math.max(0, opts.findIndex((o) => o.value === q.default));
        setAskOptions(opts);
        setDialogOptionSel(idx);
        dialogOptionSelRef.current = idx;
        setAskMode("choice");
      } else {
        setAskOptions([]);
        setAskMode(q.type);
        setCommand("");
        setFocus("command");
      }
    });

  const resolveAsk = (value: string) => {
    const pending = pendingAskRef.current;
    pendingAskRef.current = null;
    setAskMode(null);
    pending?.resolve(value);
  };


  const askDialog: Dialog | null =
    askMode === "choice"
      ? {
          title: askPrompt,
          lines: askLines,
          confirmText: t("ui.ok"),
          cancelText: t("ui.cancel"),
          options: askOptions,
          hideButtons: true,
          onConfirm: () => resolveAsk(askOptions[dialogOptionSelRef.current]?.value ?? ""),
          onCancel: () => resolveAsk(""),
        }
      : null;

  const askInfoDialog: Dialog | null =
    (askMode === "text" || askMode === "password") && askLines.length > 0
      ? {
          title: askPrompt,
          lines: askLines,
          confirmText: t("ui.sendNav"),
          cancelText: t("ui.cancel"),
          hideButtons: true,
          onConfirm: () => {},
          onCancel: () => {},
        }
      : null;


  useEffect(() => {
    const unsubs = [
      core.bus.on("chain:update", (c) => setChain(c)),
      core.bus.on("balance:update", (b) => setBalance(b)),
      core.bus.on("connection:change", (n) => setConnectedNodes(n)),
      core.bus.on("fees:update", (f) => setFees(f)),
      core.bus.on("tx:update", (t) => setTxs(t)),
      core.bus.on("shutdown", () => onExit()),
    ];
    const unsubLog = log.onSink((line) => setLogs((prev) => [...prev.slice(-499), line]));


    setConnectedNodes(core.conn.connectedCount);
    setChain(core.chain.toView());
    void core.getBalance().then(setBalance).catch(() => {});
    void core
      .getBalanceDetail()
      .then((d) => {
        if (d) {
          setChainBalance(d.chain);
          setReservedBalance(d.reserved);
          setImmatureBalance(d.immature);
        }
      })
      .catch(() => {});
    return () => {
      for (const unsub of unsubs) unsub();
      unsubLog();
    };
  }, [core, log, onExit]);



  useEffect(() => {
    let cancelled = false;
    // The QR code always mirrors the address currently selected on the receive page.
    const addresses = core.walletAddresses();
    const list = addresses.length > 0 ? addresses : [core.getAddress()];
    const target = list[receiveIndex] ?? list[0] ?? core.getAddress();
    void qrLines(target)
      .then((lines) => {
        if (!cancelled) setQr(lines);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [core, receiveIndex]);


  useEffect(() => {
    refresh();

  }, []);


  const refresh = () => {
    void core.refreshAll();
    void core.getFees(true).then(setFees).catch((e) => log.warn(`Fee fetch failed: ${(e as Error).message}`));
    void core.refreshTransactions(20);
    void core
      .getBalanceDetail()
      .then((d) => {
        if (d) {
          setChainBalance(d.chain);
          setReservedBalance(d.reserved);
          setImmatureBalance(d.immature);
        }
      })
      .catch(() => {});
  };

  const scrollBy = (d: number) => setScroll((s) => Math.max(0, s + d));

  const toggleMouse = () => {
    const next = !mouseOn;
    setMouseOn(next);
    stdout.write(next ? MOUSE_ENABLE : MOUSE_DISABLE);
    log.info(t(next ? "log.mouseOn" : "log.mouseOff"));
  };

  const toggleMode = () => {
    const next: UiMode = mode === "mouse" ? "command" : "mouse";
    setMode(next);
    setScroll(0);
    setDialog(null);
    if (next === "command") setFocus("command");



    if (!envDegraded) saveUiMode(config.datadir, next);
    log.info(t(next === "command" ? "log.modeCommand" : "log.modeMouse"));
  };

  const toggleLang = () => {
    const next = nextLang(lang);
    setLang(next);
    setLangState(next);
    saveLang(config.datadir, next);
  };


  const copyAddress = () => {
    void (async () => {
      const addresses = core.walletAddresses();
      const list = addresses.length > 0 ? addresses : [core.getAddress()];
      const target = list[receiveIndex] ?? list[0] ?? core.getAddress();
      const ok = await copyToClipboard(target);
      setCopyMsg(
        ok ? t("ui.copyMsg") : "Copy failed: no clipboard tool found (press Ctrl+T to disable mouse and select to copy)",
      );
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyMsg(null), 4000);
    })();
  };

  /** Switch the receive page to another derived address (wraps around). */
  const selectReceiveAddress = (index: number) => {
    const count = core.walletAddresses().length;
    if (count === 0) return;
    setReceiveIndex(((index % count) + count) % count);
    setCopyMsg(null);
  };

  /** Derive a fresh receive address and select it on the receive page. */
  const newReceiveAddress = () => {
    const fresh = core.getNewAddress();
    const list = core.walletAddresses();
    const index = Math.max(0, list.indexOf(fresh));
    setReceiveIndex(index);
    setCopyMsg(null);
    refresh();
  };


  const copyTxid = () => {
    const m = sendResult?.match(/txid=([^\s（]+)/);
    const txid = m?.[1];
    if (!txid) return;
    void (async () => {
      const ok = await copyToClipboard(txid);
      const suffix = ok ? ` ${t("send.copySuffix")}` : t("send.copyFailed");
      setSendResult((prev) => (prev ? `${prev}${suffix}` : prev));
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setSendResult((prev) => (prev ? (prev.endsWith(suffix) ? prev.slice(0, -suffix.length) : prev) : prev));
      }, 2500);
    })();
  };

  const switchView = (name: ViewName) => {
    setView(name);
    setScroll(0);
    if (name !== "send") setFocus("command");
    refresh();
  };

  const focusField = (f: FocusTarget, row?: number) => {
    setFocus(f);
    if (row !== undefined) setFocusRow(row);
    setSendResult(null);
  };

  const setTier = (t: FeeTierName) => {
    setDraft((d) => ({ ...d, tier: d.tier === t ? null : t, fee: "" }));
    setSendResult(null);
  };

  const resetSend = () => {
    setDraft(emptySendDraft());
    setFocusRow(0);
    setSendResult(null);
  };

  const addRow = () => {
    setDraft((d) =>
      d.recipients.length >= MAX_RECIPIENTS
        ? d
        : { ...d, recipients: [...d.recipients, { address: "", amount: "" }] },
    );
    setSendResult(null);
  };

  const delRow = () => {
    setDraft((d) => (d.recipients.length <= 1 ? d : { ...d, recipients: d.recipients.slice(0, -1) }));
    setFocusRow((r) => Math.max(0, r - 1));
    setSendResult(null);
  };

  const doSend = async () => {
    setSendBusy(true);
    setSendResult(null);
    try {
      const payments = draft.recipients
        .filter((r) => r.address.trim() !== "" && r.amount.trim() !== "")
        .map((r) => ({ address: r.address.trim(), amount: r.amount.trim() }));

      const password = dialogPasswordRef.current;
      const txid = await core.send(
        payments,
        {
          explicitFee: draft.fee.trim() === "" ? null : draft.fee,
          tier: draft.tier,
        },
        password.trim() === "" ? undefined : password,
      );
      setSendResult(t("send.success", { txid }));
      log.info(t("log.transferOk", { n: payments.length, txid }));
      setDraft(emptySendDraft());
      setFocusRow(0);
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSendResult(`Failed: ${message}`);
      log.error(`Transfer failed: ${message}`);
    } finally {
      setSendBusy(false);
    }
  };

  const submitSend = () => {
    if (sendBusy) return;

    if (!core.chain.isSynced()) {
      setSendResult(`Blocked: ${t("sync.sendBlocked")}`);
      return;
    }
    const payments = draft.recipients.filter((r) => r.address.trim() !== "" && r.amount.trim() !== "");
    if (payments.length === 0) {
      setSendResult("Failed: enter at least one recipient address and amount");
      return;
    }
    for (const r of payments) {
      if (r.address.trim() === "") {
        setSendResult("Failed: enter a recipient address");
        return;
      }
      if (r.amount.trim() === "") {
        setSendResult("Failed: enter an amount");
        return;
      }
    }
    setDialogSel("confirm");
    const requirePassword = core.requirePassword();
    const feeDesc =
      draft.fee.trim() !== ""
        ? `${draft.fee} ${COIN_TICKER}`
        : draft.tier
          ? t("dialog.tierLine", { tier: draft.tier, amount: trimEDX(fees?.[draft.tier] ?? ""), ticker: COIN_TICKER })
          : t("dialog.feeAutoLine", { amount: trimEDX(fees?.normal ?? ""), ticker: COIN_TICKER });
    const totalSat = payments.reduce((sum, r) => sum + parseEDX(r.amount), 0n);
    setDialogPassword("");
    dialogPasswordRef.current = "";
    setDialog({
      title: t("dialog.confirmSendTitle"),
      lines: [
        ...payments.map((r, i) =>
          t("dialog.recipientLine", {
            n: i + 1,
            addr: truncateMiddle(r.address.trim(), 40),
            amount: trimEDX(r.amount.trim()),
            ticker: COIN_TICKER,
          }),
        ),
        t("dialog.totalN", { n: payments.length, total: trimEDX(formatEDX(totalSat)), ticker: COIN_TICKER }),
        t("dialog.feeLine", { desc: feeDesc }),
        ...(requirePassword ? [t("dialog.walletPassword")] : []),
      ],
      confirmText: t("dialog.confirmSend"),
      password: requirePassword,
      onConfirm: () => {
        setDialog(null);
        void doSend();
      },
      onCancel: () => setDialog(null),
    });
  };

  const showTx = async (txid: string) => {
    try {
      const tx = await core.getTransaction(txid);
      if (!tx) return;
      setDialogSel("confirm");
      setDialog({
        title: t("dialog.txDetailTitle"),
        lines: [
          `txid: ${tx.txid}`,
          `${t("dialog.txType", { label: txTypeLabel(tx) })} | ${t("dialog.txAmount", {
            sign: tx.category === "send" ? "-" : "+",
            amount: trimEDX(tx.amount),
            ticker: COIN_TICKER,
          })}`,
          t("dialog.txFeeStatus", {
            fee: trimEDX(tx.fee),
            ticker: COIN_TICKER,
            status: txStatusLabel(tx),
            confirm: txConfirmText(tx),
            height: tx.height ?? "-",
          }),
          ...(txMaturityLine(tx) ? [txMaturityLine(tx)!] : []),
          ...(tx.failed ? [t("dialog.txFailedReason", { reason: tx.lastError ?? "-" })] : []),
          t("dialog.txTime", { time: new Date(tx.time * 1000).toLocaleString(currentLocale(), { hour12: false }) }),
          ...tx.outputs.map((output) =>
            t("dialog.outputLine", {
              label: output.isChange
                ? t("dialog.change")
                : tx.type === "mining"
                  ? t("dialog.miningReward")
                  : t("dialog.receive"),
              address: output.address,
              sign: output.isChange ? "" : "+",
              amount: trimEDX(output.amount),
              ticker: COIN_TICKER,
            }),
          ),
        ],
        confirmText: t("ui.close"),
        onConfirm: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
    } catch (e) {
      log.error(`Transaction query failed: ${(e as Error).message}`);
    }
  };

  /** Open a password-confirmation dialog whose onConfirm runs the given action. */
  const askPasswordDialog = (title: string, lines: string[], onConfirm: (password: string) => void) => {
    setDialogSel("confirm");
    setDialogPassword("");
    dialogPasswordRef.current = "";
    setDialog({
      title,
      lines: [...lines, t("dialog.walletPassword")],
      confirmText: t("ui.ok"),
      cancelText: t("ui.cancel"),
      password: true,
      onConfirm: () => {
        setDialog(null);
        onConfirm(dialogPasswordRef.current);
      },
      onCancel: () => setDialog(null),
    });
  };

  /** Show a read-only dialog carrying sensitive material (no cancel affordance needed). */
  const showSensitive = (title: string, body: string[]) => {
    setDialogSel("confirm");
    setDialog({
      title,
      lines: body,
      confirmText: t("ui.close"),
      hideButtons: true,
      onConfirm: () => setDialog(null),
      onCancel: () => setDialog(null),
    });
  };

  /** Settings page: full local chain rebuild, guarded by a confirm dialog. */
  const settingsResync = () => {
    setDialogSel("confirm");
    setDialog({
      title: t("settings.confirmResyncTitle"),
      lines: [t("settings.resyncLine")],
      confirmText: t("settings.resyncYes"),
      cancelText: t("settings.resyncNo"),
      onConfirm: () => {
        setDialog(null);
        void (async () => {
          try {
            await core.resync();
            refresh();
            log.info(t("settings.resyncDone"));
          } catch (e) {
            log.error(`Resync failed: ${(e as Error).message}`);
          }
        })();
      },
      onCancel: () => setDialog(null),
    });
  };

  /** Settings page: show the wallet mnemonic after an interactive password check. */
  const settingsShowMnemonic = () => {
    askPasswordDialog(t("settings.mnemonic"), [], (password) => {
      try {
        const mnemonic = core.getMnemonic(password.trim() === "" ? "" : password);
        showSensitive(t("settings.titleMnemonic"), [mnemonic]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(`Mnemonic export failed: ${message}`);
        showSensitive(t("settings.mnemonic"), [message]);
      }
    });
  };

  /** Settings page: show the main-address private key after an interactive password check. */
  const settingsShowPrivkey = () => {
    askPasswordDialog(t("settings.privkey"), [], (password) => {
      try {
        const wif = core.dumpPrivKey(core.getAddress(), password.trim() === "" ? "" : password);
        showSensitive(t("settings.titlePrivkey"), [wif]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(`Private key export failed: ${message}`);
        showSensitive(t("settings.privkey"), [message]);
      }
    });
  };

  /** Settings page: show the wallet-info dialog. */
  const settingsShowWalletInfo = () => {
    const info = core.getWalletInfo();
    const addresses = core.walletAddresses();
    setDialogSel("confirm");
    setDialog({
      title: t("settings.walletInfo"),
      lines: [
        t("dialog.walletName", { name: info.walletname }),
        t("settings.addresses", { count: String(addresses.length) }),
        t("settings.balanceLine", { balance: trimEDX(info.balance), ticker: COIN_TICKER }),
      ],
      confirmText: t("ui.close"),
      onConfirm: () => setDialog(null),
      onCancel: () => setDialog(null),
    });
  };

  /** Step the visible receive address page (wraps around the page count). */
  const receivePageBy = (delta: number) => {
    const all = core.walletAddresses();
    const count = all.length;
    const pageCount = Math.max(1, Math.ceil(Math.max(1, count) / RECEIVE_PAGE_SIZE));
    const currentPage = Math.floor(Math.min(Math.max(0, receiveIndex), Math.max(0, count - 1)) / RECEIVE_PAGE_SIZE);
    const nextPage = ((currentPage + delta) % pageCount + pageCount) % pageCount;
    const target = Math.min(nextPage * RECEIVE_PAGE_SIZE, count - 1);
    setReceiveIndex(Math.max(0, target));
    setCopyMsg(null);
    refresh();
  };

  const runCommand = (line: string) => {
    const id = sessionIdRef.current++;
    setSessions((prev) => [...prev.slice(-199), { id, line, output: [], ts: Date.now() }]);
    setScroll(0);

    void registry
      .execute(line, { core, log, interactive: false, ask, datadir: config.datadir })
      .then((out) => {
        if (out) {
          const lines = out.split("\n");
          setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, output: lines } : s)));
        }
      })
      .catch((e) => {
        const message = `命令执行失败：${(e as Error).message}`;
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, output: [message] } : s)));
      });
  };


  useInput((input, key) => {

    if (mouseByteState.active) {
      mouseByteState.active = false;
      return;
    }

    if (key.ctrl && input.toLowerCase() === "l") {
      toggleLang();
      return;
    }

    if (dialog?.password) {
      const nextPw = nextDialogPassword(dialogPassword, input, key);
      if (nextPw !== dialogPassword) {
        dialogPasswordRef.current = nextPw;
        setDialogPassword(nextPw);
      }
    }
    const { state: next, effect } = reduceInput(
      {
        focus,
        row: focusRow,
        command,
        cmdHistory,
        cmdIndex,
        draft,
        dialogOpen: dialog !== null || askMode === "choice",
        scroll,
        requirePassword: core.requirePassword(),
        mode,
        view,
        dialogSel,
        dialogOptions: (dialog ?? askDialog)?.options?.length ?? 0,
        dialogOptionSel,
        askActive: askMode === "text" || askMode === "password",
      },
      input,
      key,
    );
    setFocus(next.focus);
    setFocusRow(next.row);
    setCommand(next.command);
    setCmdHistory(next.cmdHistory);
    setCmdIndex(next.cmdIndex);
    setDraft(next.draft);
    setScroll(next.scroll);
    setDialogSel(next.dialogSel);
    if (next.dialogOptionSel !== dialogOptionSel) {
      dialogOptionSelRef.current = next.dialogOptionSel;
      setDialogOptionSel(next.dialogOptionSel);
    }
    if (next.draft !== draft) setSendResult(null);
    switch (effect.kind) {
      case "runCommand":
        runCommand(effect.line);
        break;
      case "exit":
        onExit();
        break;
      case "dialogConfirm": {

        const active = dialog ?? askDialog;
        if (!active) break;
        if (active.options && active.options.length > 0) active.onConfirm();
        else if (next.dialogSel === "confirm") active.onConfirm();
        else active.onCancel();
        break;
      }
      case "dialogCancel":
        setDialogSel("confirm");
        (dialog ?? askDialog)?.onCancel();
        break;
      case "toggleMouse":
        toggleMouse();
        break;
      case "toggleMode":
        if (pendingAskRef.current) resolveAsk("");
        toggleMode();
        break;
      case "switchView":
        switchView(effect.name);
        break;
      case "focusField":
        focusField(effect.field, effect.row);
        break;
      case "submitSend":
        submitSend();
        break;
      case "resetSend":
        resetSend();
        break;
      case "addRow":
        addRow();
        break;
      case "delRow":
        delRow();
        break;
      case "activateFirstRegion": {
        const first = viewResult.regions[0];
        if (first) first.action();
        break;
      }
      case "askSubmit":
        resolveAsk(effect.value);
        break;
      case "askCancel":
        resolveAsk("");
        break;
      case "none":
        break;
    }
  });




  const askPrefix = askMode === "text" || askMode === "password" ? askPrompt : undefined;
  const cmdLines = commandLineLines(command, askPrefix, askMode === "password", undefined, cols);
  const effectiveMainH = mode === "command" ? Math.max(1, mainH - (cmdLines - 1)) : mainH;


  const activeDialog = dialog ?? askDialog ?? askInfoDialog;
  const dialogW = activeDialog ? computeDialogWidth(activeDialog, cols) : 0;
  const dialogLayout = activeDialog ? computeDialogLayout(activeDialog, MAIN_TOP, effectiveMainH, cols, dialogW) : null;


  const tabsWithLabel = TABS.map((tab) => ({ name: tab.name, label: tabLabel(tab.name) }));


  const handleMouse = (e: MouseEventData) => {
    if (e.action !== "press") return;
    const x0 = e.x - 1;
    const y0 = e.y - 1;
    if (e.button === 64 || e.button === 65) {
      if (mode === "command" || view === "logs") {

        setScroll((s) => (e.button === 64 ? s + 1 : Math.max(0, s - 1)));
      } else {
        scrollBy(e.button === 64 ? -1 : 1);
      }
      return;
    }
    if (e.button !== 0) return;


    if (hitLangButton(cols, LANG_BUTTON_LABEL[lang], modeButtonLabel(mode), x0, y0)) {
      toggleLang();
      return;
    }


    if (hitModeButton(cols, modeButtonLabel(mode), x0, y0)) {
      toggleMode();
      return;
    }


    if (dialog && dialogLayout) {
      const hit = hitDialog(dialogLayout, x0, y0);
      if (hit === "confirm") dialog.onConfirm();
      else if (hit === "cancel") dialog.onCancel();
      return;
    }


    if (y0 === TAB_ROW) {
      const tab = hitTabRow(tabsWithLabel, x0, TAB_ROW, y0);
      if (tab) switchView(tab.name);
      return;
    }


    if (y0 >= MAIN_TOP && y0 < MAIN_TOP + mainH) {
      const y = y0 - MAIN_TOP;
      for (const region of viewResult.regions) {
        if (region.y === y && x0 >= region.x0 && x0 <= region.x1) {
          region.action();
          return;
        }
      }
    }
  };
  useMouse(handleMouse);


  const peersText = core
    .getPeers()
    .map((p) => {
      const source =
        p.source === "config"
          ? t("peer.config")
          : p.source === "runtime"
            ? t("peer.runtime")
            : t("peer.discovered");
      return `${p.id} ${source} ${p.addr} ${p.connected ? t("peer.connected") : t("peer.disconnected")}`;
    })
    .join("\n");
  // Windowed receive-address page: the page that holds the selected address.
  const allReceiveAddresses = core.walletAddresses();
  const safeReceiveIndex = Math.min(receiveIndex, Math.max(0, allReceiveAddresses.length - 1));
  const receivePageIndex = Math.max(
    0,
    Math.floor(Math.max(0, safeReceiveIndex) / RECEIVE_PAGE_SIZE),
  );
  const receivePage = allReceiveAddresses.slice(receivePageIndex * RECEIVE_PAGE_SIZE, (receivePageIndex + 1) * RECEIVE_PAGE_SIZE);
  const receivePageCount = Math.ceil(Math.max(1, allReceiveAddresses.length) / RECEIVE_PAGE_SIZE);
  const viewResult = buildView(
    view,
    {
      chain,
      balance,
      fees,
      txs,
      connectedNodes,
      draft,
      focus,
      focusRow,
      chainBalance,
      reservedBalance,
      immatureBalance,
      sendBusy,
      sendResult,
      logs,
      scroll,
      cols,
      mainH,
      address: core.getAddress(),
      receiveAddresses: allReceiveAddresses,
      receiveIndex: safeReceiveIndex,
      receivePage,
      receivePageIndex,
      receivePageCount,
      totalNodes: core.getPeers().length,
      selfP2pUrl: core.conn.selfPublicUrl(),
      requirePassword: core.requirePassword(),
      peersText,
      qr,
      copyMsg,
      version: "1.0.0",
      datadir: config.datadir,
    },
    {
      refresh,
      navigate: switchView,
      focusField,
      setTier,
      submitSend,
      resetSend,
      addRow,
      delRow,
      showTx,
      selectReceiveAddress,
      newReceiveAddress,
      receivePageBy,
      resync: settingsResync,
      showMnemonic: settingsShowMnemonic,
      showPrivkey: settingsShowPrivkey,
      showWalletInfo: settingsShowWalletInfo,
      reconnect: () => {
        void core.conn.refreshConnection();
        refresh();
      },
      scrollBy,
      copyAddress,
      copyTxid,
    },
  );

  const commandView = buildCommandView(sessions, logs, scroll, effectiveMainH, cols);

  const dialogH = dialogLayout?.height ?? 0;
  const dialogTop = dialogLayout?.top ?? 0;
  const dialogLeft = dialogLayout?.left ?? 0;


  const sepWidth = Math.min(cols, 120);
  let sepMarkX = -1;
  let tabX = 0;
  for (const tab of TABS) {
    if (tab.name === view) {
      sepMarkX = tabX;
      break;
    }
    tabX += strWidth(` ${tabLabel(tab.name)} `);
  }
  const showMark = sepMarkX >= 0 && sepMarkX < sepWidth;


  return (
    <Box flexDirection="column" height={Math.max(1, rows - 1)}>
      <StatusBar
        chain={chain}
        balance={balance}
        config={config}
        mouseOn={mouseOn}
        mode={mode}
        lang={lang}
        onToggleMode={toggleMode}
        onToggleLang={toggleLang}
        connectedNodes={connectedNodes}
        totalNodes={core.getPeers().length}
      />
      <Box>
        {showMark ? (
          <>
            <Text dimColor>{"─".repeat(sepMarkX)}</Text>
            <Text color={C.fg} bold>▼</Text>
            <Text dimColor>{"─".repeat(Math.max(0, sepWidth - sepMarkX - 1))}</Text>
          </>
        ) : (
          <Text dimColor>{"─".repeat(sepWidth)}</Text>
        )}
      </Box>
      {mode === "mouse" && (
        <Box>
          {TABS.map((tab) => {
            const active = view === tab.name;
            const label = tabLabel(tab.name);
            const sp = label.indexOf(" ");
            const num = sp > 0 ? label.slice(0, sp) : label;
            const name = sp > 0 ? label.slice(sp + 1) : "";
            return (


              <Text key={tab.name} backgroundColor={active ? C.accent : undefined}>
                <Text color={active ? C.fg : C.grayDim} bold={active}>
                  {active ? `│${num}` : ` ${num}`}
                </Text>
                <Text color={active ? C.white : C.gray} bold={active}>{` ${name} `}</Text>
              </Text>
            );
          })}
        </Box>
      )}
      <Box position="relative" flexDirection="column" flexGrow={1} minHeight={1}>
        {(mode === "command" ? commandView : viewResult).rows.map((row, i) => (
          <Box key={i}>
            {row.segments ? (
              row.segments.map((seg, j) => (
                <Text key={j} color={seg.color} dimColor={seg.dim} bold={seg.bold} inverse={seg.inverse} backgroundColor={seg.bg}>
                  {seg.text}
                </Text>
              ))
            ) : (
              <Text color={row.color} dimColor={row.dim} bold={row.bold}>
                {row.text}
              </Text>
            )}
          </Box>
        ))}
        {(dialog || askDialog || askInfoDialog) && (
          <>
            { }
            <Box
              position="absolute"
              marginTop={dialogTop - (mode === "mouse" ? MAIN_TOP : MAIN_TOP - 1)}
              width={cols}
              height={dialogH}
              flexDirection="column"
            >
              {Array.from({ length: dialogH }, (_, i) => (
                <Text key={i} backgroundColor={C.bg}>{" ".repeat(cols)}</Text>
              ))}
            </Box>
            <Box
              position="absolute"
              marginTop={dialogTop - (mode === "mouse" ? MAIN_TOP : MAIN_TOP - 1)}
              marginLeft={dialogLeft}
              width={dialogW}
              height={dialogH}
              flexDirection="column"
            >
            {(() => {
              const d = (dialog ?? askDialog ?? askInfoDialog)!;
              const rowW = dialogW - 2;
              const textW = dialogW - 4;
              const title = `► ${d.title}`;
              const hint = fitLine(dialogHint(d), Math.max(0, textW - cw(title)));
              const titleText = `${title}${hint}`;
              const btnConfirm = `[${d.confirmText}]`;
              const btnCancel = `[${d.cancelText ?? t("ui.cancel")}]`;
              const btnRow = `${btnConfirm}  ${btnCancel}`;

              const borderLine = (left: string, right: string, content: string) => (
                <Text wrap="truncate">
                  <Text color={C.fg} bold backgroundColor={C.bg}>{left}</Text>
                  <Text color={C.fg} backgroundColor={C.bg}>{content}</Text>
                  <Text color={C.fg} bold backgroundColor={C.bg}>{right}</Text>
                </Text>
              );
              const contentLine = (children: React.ReactNode, key?: string | number) => (
                <Text key={key} wrap="truncate">
                  <Text color={C.fg} backgroundColor={C.bg}>│</Text>
                  {children}
                  <Text color={C.fg} backgroundColor={C.bg}>│</Text>
                </Text>
              );
              return (
                <>
                  {borderLine("╭", "╮", "─".repeat(rowW))}
                  {contentLine(
                    <>
                      <Text backgroundColor={C.bg}>{" "}</Text>
                      <Text bold color={C.fg} backgroundColor={C.bg}>{title}</Text>
                      <Text color={C.grayDim} backgroundColor={C.bg}>{hint}</Text>
                      <Text backgroundColor={C.bg}>{" ".repeat(Math.max(0, rowW - 1 - cw(titleText)))}</Text>
                    </>
                  )}
                  {d.lines.map((line, i) => {
                    if (d.password && i === d.lines.length - 1) {
                      const masked = dialogPassword.length > 0 ? "*".repeat(dialogPassword.length) : "";
                      const inner = masked !== "" ? `${masked}▌` : `${t("dialog.enterPassword")}▌`;
                      const pwText = `${t("dialog.walletPassword")}[${inner}]`;
                      return contentLine(
                        <Text backgroundColor={C.bg}>
                          <Text backgroundColor={C.bg}>{" "}</Text>
                          <Text color={C.grayDim} backgroundColor={C.bg}>{t("dialog.walletPassword")}</Text>
                          <Text color={C.fg} backgroundColor={C.black}>[</Text>
                          <Text color={masked !== "" ? C.fg : C.gray} bold={masked !== ""} backgroundColor={C.black}>{inner}</Text>
                          <Text color={C.fg} backgroundColor={C.black}>]</Text>
                          <Text backgroundColor={C.bg}>{" ".repeat(Math.max(0, rowW - 1 - cw(pwText)))}</Text>
                        </Text>,
                        i,
                      );
                    }
                    const l = fitLine(line, textW);
                    return contentLine(
                      <Text backgroundColor={C.bg}>
                        <Text backgroundColor={C.bg}>{" "}</Text>
                        {l}
                        <Text backgroundColor={C.bg}>{" ".repeat(Math.max(0, rowW - 1 - cw(l)))}</Text>
                      </Text>,
                      i,
                    );
                  })}
                  {d.options?.map((o, i) => {
                    const selected = i === dialogOptionSel;
                    const optLine = `${selected ? "▶" : " "} ${o.label}`;
                    const padded = fitLine(optLine, textW);
                    return contentLine(
                      <Text backgroundColor={C.bg}>
                        <Text backgroundColor={C.bg}>{" "}</Text>
                        <Text inverse={selected} color={selected ? C.fg : C.gray} backgroundColor={C.bg}>{padded}</Text>
                        <Text backgroundColor={C.bg}>{" ".repeat(Math.max(0, rowW - 1 - cw(padded)))}</Text>
                      </Text>,
                      i,
                    );
                  })}
                  {contentLine(<Text backgroundColor={C.bg}>{" ".repeat(rowW)}</Text>)}
                  {!d.hideButtons &&
                    contentLine(
                      <>
                        <Text backgroundColor={C.bg}>{" "}</Text>
                        <Text inverse={dialogSel === "confirm"} color={C.fg} bold backgroundColor={C.bg}>{btnConfirm}</Text>
                      <Text backgroundColor={C.bg}>{"  "}</Text>
                      <Text inverse={dialogSel === "cancel"} color={C.gray} dimColor backgroundColor={C.bg}>{btnCancel}</Text>
                      <Text backgroundColor={C.bg}>{" ".repeat(Math.max(0, rowW - 1 - cw(btnRow)))}</Text>
                    </>
                  )}
                  {borderLine("╰", "╯", "─".repeat(rowW))}
                </>
              );
            })()}
            </Box>
          </>
        )}
      </Box>
      {mode === "command" && (
        <CommandLine
          value={command}
          focused={focus === "command"}
          prefix={askMode === "text" || askMode === "password" ? askPrompt : undefined}
          masked={askMode === "password"}
          cols={cols}
        />
      )}
      {mode === "mouse" && (
        <StatusFooter
          connectedNodes={connectedNodes}
          totalNodes={core.getPeers().length}
          cols={cols}
        />
      )}
    </Box>
  );
}
