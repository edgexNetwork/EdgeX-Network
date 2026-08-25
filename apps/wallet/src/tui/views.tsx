import { formatNumber, padCJK, truncateMiddle, txConfirmText, txStatusLabel, txTypeLabel } from "../utils/display";
import { trimEDX, formatEDX, parseEDX } from "../utils/amount";
import { COIN_TICKER, MINING_MATURITY_CONFIRMATIONS } from "../utils/constants";
import type { ChainInfoView, FeeTiers, TxView } from "../api/types";
import type { LogLine } from "../utils/log";
import { FEE_TIER_NAMES, type FeeTierName } from "../core/fee";
import { currentLocale, t } from "../i18n";
import { C } from "./theme";

export type ViewName = "balance" | "send" | "receive" | "history" | "network" | "fees" | "logs";
export type FocusTarget = "command" | "to" | "amount" | "fee" | "sendBtn" | "resetBtn" | "addRow" | "delRow";
export type UiMode = "mouse" | "command";


export function modeButtonLabel(mode: UiMode): string {
  return mode === "mouse" ? `[${t("ui.modeToCommand")}]` : `[${t("ui.modeToMouse")}]`;
}


export const TABS: { name: ViewName }[] = [
  { name: "balance" },
  { name: "send" },
  { name: "receive" },
  { name: "history" },
  { name: "network" },
  { name: "fees" },
  { name: "logs" },
];

const TAB_NUM: Record<ViewName, string> = {
  balance: "01",
  send: "02",
  receive: "03",
  history: "04",
  network: "05",
  fees: "06",
  logs: "07",
};


export function tabLabel(name: ViewName): string {
  return `${TAB_NUM[name]} ${t(`tab.${name}`)}`;
}


export interface SessionItem {
  id: number;
  line: string;
  output: string[];
  ts: number;
}

export interface RowSegment {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;

  inverse?: boolean;

  bg?: string;
}

export interface Row {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;

  segments?: RowSegment[];
}

export interface Region {
  y: number;
  x0: number;
  x1: number;
  action: () => void;
}

export interface ViewResult {
  rows: Row[];
  regions: Region[];
}

export interface RecipientDraft {
  address: string;
  amount: string;
}


export const MAX_RECIPIENTS = 5;

export interface SendDraft {

  recipients: RecipientDraft[];
  fee: string;
  tier: FeeTierName | null;
}


export function emptySendDraft(): SendDraft {
  return { recipients: [{ address: "", amount: "" }], fee: "", tier: null };
}

export interface ViewSnapshot {
  chain: ChainInfoView | null;
  balance: string | null;
  fees: FeeTiers | null;
  txs: TxView[];
  connectedNodes: number;

  totalNodes: number;
  draft: SendDraft;
  focus: FocusTarget;

  focusRow: number;

  chainBalance: string | null;

  reservedBalance: string | null;

  immatureBalance: string | null;
  sendBusy: boolean;
  sendResult: string | null;
  logs: LogLine[];
  scroll: number;
  cols: number;
  mainH: number;
  address: string;

  selfP2pUrl: string;

  requirePassword: boolean;
  peersText: string;
  qr: string[] | null;

  copyMsg: string | null;
}

export interface ViewActions {
  refresh: () => void;

  copyAddress: () => void;

  copyTxid: () => void;

  navigate: (name: ViewName) => void;
  focusField: (f: "to" | "amount" | "fee", row?: number) => void;
  setTier: (t: FeeTierName) => void;
  submitSend: () => void;
  resetSend: () => void;

  addRow: () => void;

  delRow: () => void;
  showTx: (txid: string) => void;
  reconnect: () => void;
  scrollBy: (d: number) => void;
}



function viewWidth(cols: number): number {
  return Math.min(cols, 120);
}






export function w2(s: string): number {
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


function fitW(s: string, maxW: number): string {
  if (w2(s) <= maxW) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const chW = w2(ch);
    if (w + chW > maxW - 1) break;
    out += ch;
    w += chW;
  }
  return `${out}…`;
}


function sectionHeader(text: string): Row {
  return { text: `► ${text}`, color: C.fg, bold: true };
}


function boxTop(cols: number, title: string): Row {
  const width = viewWidth(cols);
  const inner = ` ► ${title} `;
  const dashes = Math.max(0, width - 2 - w2(inner));
  return {
    text: `┌${inner}${"─".repeat(dashes)}┐`,
    segments: [
      { text: "┌", color: C.borderDim },
      { text: " ", color: undefined },
      { text: "►", color: C.fg, bold: true },
      { text: ` ${title} `, color: C.fg, bold: true },
      { text: `${"─".repeat(dashes)}┐`, color: C.borderDim },
    ],
  };
}


function boxBottom(cols: number): Row {
  const width = viewWidth(cols);
  return { text: `└${"─".repeat(Math.max(0, width - 2))}┘`, color: C.borderDim };
}


function boxTopAccent(cols: number, title: string): Row {
  const width = viewWidth(cols);
  const inner = ` ► ${title} `;
  const dashes = Math.max(0, width - 2 - w2(inner));
  return {
    text: `┃${inner}${"─".repeat(dashes)}┐`,
    segments: [
      { text: "┃", color: C.fg },
      { text: " ", color: undefined },
      { text: "►", color: C.fg, bold: true },
      { text: ` ${title} `, color: C.fg, bold: true },
      { text: `${"─".repeat(dashes)}┐`, color: C.borderDim },
    ],
  };
}


function boxBottomAccent(cols: number): Row {
  const width = viewWidth(cols);
  return { text: `┗${"─".repeat(Math.max(0, width - 2))}┘`, color: C.borderDim };
}


function closeEdge(segs: RowSegment[], cols: number): RowSegment[] {
  const used = segs.reduce((n, s) => n + w2(s.text), 0);
  const pad = Math.max(0, viewWidth(cols) - 1 - used);
  return [...segs, { text: `${" ".repeat(pad)}│`, color: C.borderDim }];
}


function btn(y: number, x0: number, text: string, action: () => void): { row: Row; region: Region } {

  return {
    row: {
      text,
      segments: [
        { text: "[", color: C.border, bg: C.bg, bold: true },
        { text: text.slice(1, -1), color: C.fg, bg: C.bg, bold: true },
        { text: "]", color: C.border, bg: C.bg, bold: true },
      ],
    },
    region: { y, x0, x1: x0 + w2(text) - 1, action },
  };
}

function inputBox(y: number, label: string, value: string, placeholder: string, focused: boolean, action: () => void, cols: number, masked = false): { rows: Row[]; regions: Region[] } {
  const labelW = w2(label) + 2;
  const shown = masked && value !== "" ? "*".repeat(value.length) : value;
  const inner = focused ? `${shown}▌` : shown === "" ? placeholder : shown;

  const border = focused ? C.fg : C.border;
  const text = `│ ${label}${" ".repeat(2)}[${inner}]`;
  const rows: Row[] = [
    {
      text,
      segments: closeEdge([
        { text: "│ ", color: C.borderDim },
        { text: `${label}${" ".repeat(2)}`, color: C.grayDim },
        { text: "[", color: border, bg: C.black },
        { text: inner, color: focused ? C.fg : shown === "" ? C.gray : C.fg, bold: focused || shown !== "", bg: C.black },
        { text: "]", color: border, bg: C.black },
      ], cols),
    },
  ];
  const regions: Region[] = [{ y, x0: labelW + 2, x1: cols - 1, action }];
  return { rows, regions };
}

function balanceView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  const chain = snap.chain;

  rows.push(boxTop(snap.cols, t("ui.addressCard")));
  const copyBtn = `[${t("ui.copyAddress")}]`;
  const copyBtnW = w2(copyBtn);
  const addrW = Math.max(8, snap.cols - 6 - 1 - copyBtnW);
  const addrShown = truncateMiddle(snap.address, addrW);
  const addrLabel = `${t("ui.address")}: `;
  rows.push({
    text: `${addrLabel}${addrShown} ${copyBtn}`,
    segments: closeEdge([
      { text: addrLabel, color: C.grayDim },
      { text: addrShown, color: C.fg, bold: true },
      { text: " ", color: undefined },
      { text: "[", color: C.border, bg: C.bg, bold: true },
      { text: t("ui.copyAddress"), color: C.fg, bg: C.bg, bold: true },
      { text: "]", color: C.border, bg: C.bg, bold: true },
    ], snap.cols),
  });
  const copyX0 = w2(addrLabel) + w2(addrShown) + 1;
  regions.push({ y: 1, x0: copyX0, x1: copyX0 + copyBtnW - 1, action: actions.copyAddress });
  rows.push(boxBottom(snap.cols));



  rows.push(boxTopAccent(snap.cols, t("ui.balanceCard")));
  const balAmount = snap.balance === null ? "--" : trimEDX(snap.balance);
  const balLabel = `${t("ui.balanceLabel")}: `;
  rows.push({
    text: `${balLabel}${balAmount}${snap.balance === null ? "" : ` ${COIN_TICKER}`}`,
    segments: closeEdge([
      { text: "┃ ", color: C.fg },
      { text: balLabel, color: C.grayDim },
      { text: balAmount, color: snap.balance !== null && parseFloat(snap.balance) > 0 ? C.fg : C.white, bold: true },
      { text: snap.balance === null ? "" : ` ${COIN_TICKER}`, color: C.fg, bold: true },
    ], snap.cols),
  });
  if (
    snap.chainBalance !== null &&
    snap.reservedBalance !== null &&
    snap.reservedBalance !== "0.00000000"
  ) {
    const line = t("ui.chainBalance", { amount: trimEDX(snap.chainBalance), ticker: COIN_TICKER, reserved: trimEDX(snap.reservedBalance) });
    rows.push({
      text: `┃ ${line}`,
      segments: closeEdge([
        { text: "┃ ", color: C.fg },
        { text: line, color: C.gray },
      ], snap.cols),
    });
  }
  if (snap.immatureBalance !== null && snap.immatureBalance !== "0.00000000") {
    const line = t("ui.immature", { amount: trimEDX(snap.immatureBalance), ticker: COIN_TICKER });
    rows.push({
      text: `┃ ${line}`,
      segments: closeEdge([
        { text: "┃ ", color: C.fg },
        { text: line, color: C.amber },
      ], snap.cols),
    });
  }
  rows.push(boxBottomAccent(snap.cols));


  rows.push(boxTop(snap.cols, t("ui.networkCard")));
  const connText = t("network.p2p", { a: snap.connectedNodes, b: snap.totalNodes });
  const heightText = chain ? t("ui.heightLine", { height: formatNumber(chain.blocks) }) : t("ui.heightNone");
  const phaseText = chain ? t("ui.phaseLine", { phase: chain.phase }) : t("ui.phaseNone");
  const rewardText = chain ? t("ui.rewardLine", { amount: trimEDX(chain.blockReward), ticker: COIN_TICKER }) : t("ui.rewardNone");
  rows.push({
    text: `${connText} | ${heightText} | ${phaseText} | ${rewardText}`,
    segments: closeEdge([
      { text: "│ ", color: C.borderDim },
      { text: `${connText} | ${heightText} | ${phaseText} | ${rewardText}`, color: snap.connectedNodes > 0 ? C.fg : C.red },
    ], snap.cols),
  });

  const syncStatus = chain?.syncStatus ?? "none";
  const syncColor = !chain || syncStatus === "synced" ? C.gray : syncStatus === "error" ? C.red : C.amber;
  const syncLineText = chain
    ? t("ui.syncLine", { pct: (chain.syncProgress * 100).toFixed(1), amount: trimEDX(chain.supply), ticker: COIN_TICKER })
    : t("ui.syncWaiting");
  rows.push({
    text: syncLineText,
    segments: closeEdge([
      { text: "│ ", color: C.borderDim },
      { text: syncLineText, color: syncColor },
    ], snap.cols),
  });

  if (chain && syncStatus !== "synced") {
    const bannerText =
      syncStatus === "error"
        ? t("sync.bannerError", { reason: chain.syncError ?? "" })
        : t("sync.bannerSyncing", { pct: (chain.syncProgress * 100).toFixed(1) });
    const bannerColor = syncStatus === "error" ? C.red : C.amber;
    rows.push({
      text: bannerText,
      segments: closeEdge([
        { text: "│ ", color: C.borderDim },
        { text: bannerText, color: bannerColor, bold: syncStatus === "error" },
      ], snap.cols),
    });
  }
  rows.push(boxBottom(snap.cols));

  if (snap.copyMsg) rows.push({ text: snap.copyMsg, color: C.fg });

  const navSend = btn(rows.length, 0, `[${t("ui.sendNav")}]`, () => actions.navigate("send"));
  const navReceive = btn(rows.length, 8, `[${t("ui.receiveNav")}]`, () => actions.navigate("receive"));
  const refBtn = btn(rows.length, 16, `[${t("ui.refresh")}]`, actions.refresh);
  rows.push({
    text: `${navSend.row.text} ${navReceive.row.text} ${refBtn.row.text}`,
    segments: [
      ...navSend.row.segments!,
      { text: " ", color: undefined },
      ...navReceive.row.segments!,
      { text: " ", color: undefined },
      ...refBtn.row.segments!,
    ],
  });
  regions.push(navSend.region, navReceive.region, refBtn.region);
  return { rows, regions };
}


function recipientRow(
  y: number,
  index: number,
  recipient: RecipientDraft,
  focused: "to" | "amount" | null,
  onFocusTo: () => void,
  onFocusAmount: () => void,
  cols: number,
): { rows: Row[]; regions: Region[] } {
  const label = `${t("send.recipientN", { n: index + 1 })}: `;
  const addrW = Math.max(10, Math.floor(cols * 0.5));
  const amtW = Math.max(6, cols - w2(label) - addrW - 9);
  const addrInner = focused === "to" ? `${recipient.address}▌` : recipient.address === "" ? t("send.enterAddress") : recipient.address;
  const amtInner = focused === "amount" ? `${recipient.amount}▌` : recipient.amount === "" ? t("send.enterAmount") : recipient.amount;
  const addrPad = Math.max(0, addrW - w2(addrInner));
  const amtPad = Math.max(0, amtW - w2(amtInner));

  const addrBorder = focused === "to" ? C.fg : C.border;
  const amtBorder = focused === "amount" ? C.fg : C.border;
  const addrX0 = w2(label);
  const text = `│ ${label} [${addrInner}${" ".repeat(addrPad)}] [${amtInner}${" ".repeat(amtPad)}]`;
  return {
    rows: [
      {
        text,
        segments: closeEdge([
          { text: "│ ", color: C.borderDim },
          { text: label, color: C.grayDim },
          { text: " ", color: undefined },
          { text: "[", color: addrBorder, bg: C.black },
          { text: addrInner, color: focused === "to" ? C.fg : recipient.address === "" ? C.gray : C.fg, bold: focused === "to" || recipient.address !== "", bg: C.black },
          { text: " ".repeat(addrPad), color: undefined, bg: C.black },
          { text: "]", color: addrBorder, bg: C.black },
          { text: " ", color: undefined },
          { text: "[", color: amtBorder, bg: C.black },
          { text: amtInner, color: focused === "amount" ? C.fg : recipient.amount === "" ? C.gray : C.fg, bold: focused === "amount" || recipient.amount !== "", bg: C.black },
          { text: " ".repeat(amtPad), color: undefined, bg: C.black },
          { text: "]", color: amtBorder, bg: C.black },
        ], cols),
      },
    ],
    regions: [
      { y, x0: addrX0 + 1, x1: addrX0 + addrW + 2, action: onFocusTo },
      { y, x0: addrX0 + addrW + 4, x1: addrX0 + addrW + amtW + 5, action: onFocusAmount },
    ],
  };
}


function sendHeader(cols: number, balance: string | null): Row {
  const width = viewWidth(cols);
  const title = `► ${t("send.headerTitle")}`;
  const balText = balance === null ? "--" : `${trimEDX(balance)} ${COIN_TICKER}`;
  const right = `${t("send.available")}: ${balText}`;
  const dashes = Math.max(0, width - 5 - w2(title) - w2(right));
  return {
    text: `┌ ${title}${"─".repeat(dashes)} ${right} ┐`,
    segments: [
      { text: "┌", color: C.borderDim },
      { text: " ", color: undefined },
      { text: title, color: C.fg, bold: true },
      { text: "─".repeat(dashes), color: C.borderDim },
      { text: " ", color: undefined },
      { text: `${t("send.available")}: `, color: C.grayDim },
      { text: balText, color: C.fg, bold: true },
      { text: " ┐", color: C.borderDim },
    ],
  };
}


function tierInfo(tier: FeeTierName): { name: string; desc: string } {
  const map: Record<FeeTierName, { name: string; desc: string }> = {
    slow: { name: t("send.tierSlow"), desc: t("send.tierDescSlow") },
    normal: { name: t("send.tierNormal"), desc: t("send.tierDescNormal") },
    fast: { name: t("send.tierFast"), desc: t("send.tierDescFast") },
  };
  return map[tier];
}

function tierBoxes(y: number, snap: ViewSnapshot, actions: ViewActions): { rows: Row[]; regions: Region[] } {
  const cols = snap.cols;
  const boxW = Math.max(14, Math.floor((viewWidth(cols) - 4) / 3));
  const inner = boxW - 2;
  const fees = snap.fees;
  const rows: Row[] = [];
  const regions: Region[] = [];
  const topSegs: RowSegment[] = [{ text: "│ ", color: C.borderDim }];
  const botSegs: RowSegment[] = [{ text: "│ ", color: C.borderDim }];
  const topTexts: string[] = [];
  const botTexts: string[] = [];
  let x = 2;
  for (const t of FEE_TIER_NAMES) {
    const info = tierInfo(t);
    const value = fees ? `${trimEDX(fees[t])} ${COIN_TICKER}` : "--";
    let name = `[${info.name}]`;
    let valueText = value;
    let fit = inner - w2(name) - w2(valueText);
    if (fit < 0) {
      valueText = fitW(valueText, Math.max(0, inner - w2(name)));
      fit = inner - w2(name) - w2(valueText);
      if (fit < 0) {
        name = fitW(name, Math.max(0, inner - w2(valueText)));
        fit = inner - w2(name) - w2(valueText);
      }
    }
    const dashes = Math.max(0, fit);
    const sel = snap.draft.tier === t;
    const bg = sel ? C.fg : C.bg;
    const border = sel ? "#000000" : C.borderDim;
    const valueFg = sel ? "#000000" : t === "fast" ? C.amber : t === "normal" ? C.fg : C.dim;
    const desc = info.desc;
    topSegs.push({ text: "┌", color: border, bg, bold: true });
    topSegs.push({ text: name, color: sel ? "#000000" : C.white, bg, bold: true });
    topSegs.push({ text: "─".repeat(dashes), color: border, bg });
    topSegs.push({ text: valueText, color: valueFg, bg, bold: true });
    topSegs.push({ text: "┐", color: border, bg, bold: true });
    topSegs.push({ text: " ", color: undefined });
    botSegs.push({ text: "│", color: border, bg });
    botSegs.push({ text: ` ${desc}`, color: sel ? "#000000" : C.grayDim, bg, bold: sel });
    botSegs.push({ text: " ".repeat(Math.max(0, inner - 1 - w2(desc))), color: undefined, bg });
    botSegs.push({ text: "│", color: border, bg });
    botSegs.push({ text: " ", color: undefined });
    topTexts.push(`┌${name}${"─".repeat(dashes)}${valueText}┐`);
    botTexts.push(`│ ${desc}${" ".repeat(Math.max(0, inner - 1 - w2(desc)))}│`);
    regions.push(
      { y, x0: x, x1: x + boxW - 1, action: () => actions.setTier(t) },
      { y: y + 1, x0: x, x1: x + boxW - 1, action: () => actions.setTier(t) },
    );
    x += boxW + 1;
  }
  rows.push({ text: `│ ${topTexts.join(" ")}`, segments: closeEdge(topSegs, cols) });
  rows.push({ text: `│ ${botTexts.join(" ")}`, segments: closeEdge(botSegs, cols) });
  return { rows, regions };
}

function sendView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  const draft = snap.draft;
  const focusedField: "to" | "amount" | null =
    snap.focus === "to" || snap.focus === "amount" ? snap.focus : null;

  rows.push(sendHeader(snap.cols, snap.balance));
  let nextY = 1;
  draft.recipients.forEach((recipient, i) => {
    const box = recipientRow(
      nextY,
      i,
      recipient,
      focusedField !== null && snap.focusRow === i ? focusedField : null,
      () => actions.focusField("to", i),
      () => actions.focusField("amount", i),
      snap.cols,
    );
    rows.push(...box.rows);
    regions.push(...box.regions);
    nextY++;
  });

  const feeText = draft.fee !== "" ? draft.fee : draft.tier ? `${draft.tier} ${trimEDX(snap.fees?.[draft.tier] ?? "")}` : t("send.feeAuto");
  const feeBox = inputBox(nextY, t("send.feeLabel"), draft.fee, feeText, snap.focus === "fee", () => actions.focusField("fee"), snap.cols);
  rows.push(...feeBox.rows);
  regions.push(...feeBox.regions);
  nextY++;


  rows.push({
    text: `│ ${t("send.feeSpeedTitle")}`,
    segments: closeEdge([
      { text: "│ ", color: C.borderDim },
      { text: t("send.feeSpeedTitle"), color: C.gray, bold: true },
    ], snap.cols),
  });
  nextY++;


  const tierBox = tierBoxes(nextY, snap, actions);
  rows.push(...tierBox.rows);
  regions.push(...tierBox.regions);
  nextY += 2;


  const summaryTitle = t("send.summaryTitle");
  rows.push({
    text: `│ ${summaryTitle} ${"┄".repeat(Math.max(4, viewWidth(snap.cols) - 4 - w2(summaryTitle)))}`,
    segments: closeEdge([
      { text: "│ ", color: C.borderDim },
      { text: summaryTitle, color: C.gray, bold: true },
      { text: " ", color: undefined },
      { text: "┄".repeat(Math.max(4, viewWidth(snap.cols) - 4 - w2(summaryTitle))), color: C.borderDim },
    ], snap.cols),
  });
  nextY++;


  const filled = draft.recipients.filter((r) => r.address.trim() !== "" && r.amount.trim() !== "");
  let totalSat: bigint | null = 0n;
  let parseOk = true;
  for (const r of filled) {
    try {
      totalSat += parseEDX(r.amount);
    } catch {
      parseOk = false;
      break;
    }
  }
  if (parseOk && totalSat !== null) {
    let feeSat = 0n;
    if (draft.fee.trim() !== "") {
      try {
        feeSat = parseEDX(draft.fee);
      } catch {
        feeSat = -1n;
      }
    } else if (draft.tier && snap.fees) {
      try {
        feeSat = parseEDX(snap.fees[draft.tier]);
      } catch {
        feeSat = 0n;
      }
    } else if (snap.fees) {
      try {
        feeSat = parseEDX(snap.fees.normal);
      } catch {
        feeSat = 0n;
      }
    }
    let balanceSat: bigint | null = null;
    if (snap.balance !== null) {
      try {
        balanceSat = parseEDX(snap.balance);
      } catch {
        balanceSat = null;
      }
    }
    const totalText = `${trimEDX(formatEDX(totalSat))} ${COIN_TICKER}`;
    const feeText2 = feeSat >= 0n ? `${trimEDX(formatEDX(feeSat))} ${COIN_TICKER}` : "--";
    const deductText = feeSat >= 0n ? `${trimEDX(formatEDX(totalSat + feeSat))} ${COIN_TICKER}` : "--";
    let changeText = "--";
    if (balanceSat !== null && feeSat >= 0n) {
      changeText = `${trimEDX(formatEDX(balanceSat - totalSat - feeSat))} ${COIN_TICKER}`;
    }
    const totalLabel = `${t("send.total")}: `;
    const feeLabel = `${t("send.feeEst")}: `;
    const deductLabel = `${t("send.deduct")}: `;
    const changeLabel = `${t("send.change")}: `;
    rows.push({
      text: `│ ${totalLabel}${totalText} | ${feeLabel}${feeText2}`,
      segments: closeEdge([
        { text: "│ ", color: C.borderDim },
        { text: totalLabel, color: C.grayDim },
        { text: totalText, color: C.white, bold: true },
        { text: ` | ${feeLabel}`, color: C.grayDim },
        { text: feeText2, color: C.gray },
      ], snap.cols),
    });
    rows.push({
      text: `│ ${deductLabel}${deductText} | ${changeLabel}${changeText}`,
      segments: closeEdge([
        { text: "│ ", color: C.borderDim },
        { text: deductLabel, color: C.grayDim },
        { text: deductText, color: C.bright, bold: true },
        { text: ` | ${changeLabel}`, color: C.grayDim },
        { text: changeText, color: C.gray },
      ], snap.cols),
    });
    nextY += 2;
  }


  const sendText = t("send.broadcastBtn");
  const resetText = t("send.resetBtn");
  const addText = t("send.addRowBtn");
  const delText = t("send.delRowBtn");
  const sendBtn = btn(nextY, 2, sendText, actions.submitSend);
  const resetBtn = btn(nextY, 2 + w2(sendText) + 1, resetText, actions.resetSend);
  const addBtn = btn(nextY, 2 + w2(sendText) + 1 + w2(resetText) + 1, addText, () => actions.addRow());
  const delBtn = btn(nextY, 2 + w2(sendText) + 1 + w2(resetText) + 1 + w2(addText) + 1, delText, () => actions.delRow());
  const btnSegments: RowSegment[] = [{ text: "│ ", color: C.borderDim }];
  for (const [button, name] of [
    [sendBtn, "sendBtn"],
    [resetBtn, "resetBtn"],
    [addBtn, "addRow"],
    [delBtn, "delRow"],
  ] as Array<[{ row: Row }, FocusTarget]>) {
    const focused = snap.focus === name;


    const bg = focused ? C.fg : C.bg;
    const fg = focused ? "#000000" : C.fg;
    const brace = focused ? "#000000" : C.border;
    const inner = button.row.text.startsWith("[") && button.row.text.endsWith("]") ? button.row.text.slice(1, -1) : button.row.text;
    btnSegments.push({ text: "[", color: brace, bg, bold: true });
    btnSegments.push({ text: inner, color: fg, bg, bold: true });
    btnSegments.push({ text: "]", color: brace, bg, bold: true });
    btnSegments.push({ text: " ", color: undefined });
  }
  rows.push({
    text: `│ ${sendBtn.row.text} ${resetBtn.row.text} ${addBtn.row.text} ${delBtn.row.text}`,
    segments: closeEdge(btnSegments, snap.cols),
  });
  regions.push(sendBtn.region, resetBtn.region, addBtn.region, delBtn.region);
  nextY++;

  if (snap.sendBusy) {
    rows.push({
      text: `│ ${t("send.busy")}`,
      segments: closeEdge([{ text: "│ ", color: C.borderDim }, { text: t("send.busy"), color: C.amber }], snap.cols),
    });
  }
  else if (snap.sendResult) {
    const failed = snap.sendResult.startsWith("Failed");
    const blocked = snap.sendResult.startsWith("Blocked");
    const resultY = nextY;
    if (blocked) {

      const msg = fitW(snap.sendResult.slice("Blocked: ".length), viewWidth(snap.cols) - 5);
      rows.push({
        text: `│ ⚠ ${msg}`,
        segments: closeEdge([
          { text: "│ ", color: C.borderDim },
          { text: "⚠ ", color: C.amber, bold: true, bg: "#1f1600" },
          { text: msg, color: C.amber, bg: "#1f1600" },
        ], snap.cols),
      });
    } else if (failed) {

      const msg = fitW(snap.sendResult, viewWidth(snap.cols) - 5);
      rows.push({
        text: `│ ✗ ${msg}`,
        segments: closeEdge([
          { text: "│ ", color: C.borderDim },
          { text: "✗ ", color: C.red, bold: true, bg: "#2a0a0a" },
          { text: msg, color: C.red, bg: "#2a0a0a" },
        ], snap.cols),
      });
    } else {

      const m = snap.sendResult.match(/txid=([^\s（]+)/);
      const txid = m?.[1] ?? "";
      const btnText = `[${t("ui.copyTxid")}]`;
      const maxMsg = viewWidth(snap.cols) - 6 - w2(btnText);

      const shown =
        txid !== "" && w2(snap.sendResult) > maxMsg
          ? `${snap.sendResult.slice(0, m!.index! + 5)}${truncateMiddle(txid, 28)}${snap.sendResult.slice(m!.index! + 5 + txid.length)}`
          : snap.sendResult;
      const msg = fitW(shown, maxMsg);
      rows.push({
        text: `│ ✓ ${msg} ${btnText}`,
        segments: closeEdge([
          { text: "│ ", color: C.borderDim },
          { text: "✓ ", color: C.fg, bold: true },
          { text: msg, color: C.fg },
          { text: " ", color: undefined },
          { text: "[", color: C.border, bg: C.bg, bold: true },
          { text: t("ui.copyTxid"), color: C.fg, bg: C.bg, bold: true },
          { text: "]", color: C.border, bg: C.bg, bold: true },
        ], snap.cols),
      });
      const btnX0 = 5 + w2(msg);
      regions.push({ y: resultY, x0: btnX0, x1: btnX0 + w2(btnText) - 1, action: actions.copyTxid });
    }
  } else {
    rows.push({ text: "│ ", segments: closeEdge([{ text: "│ ", color: C.borderDim }], snap.cols) });
  }
  nextY++;
  const hint1 = t("send.hint1");
  const hint2 = t("send.hint2");
  rows.push({
    text: `│ ${hint1}`,
    segments: closeEdge([{ text: "│ ", color: C.borderDim }, { text: hint1, color: C.gray }], snap.cols),
  });
  rows.push({
    text: `│ ${hint2}`,
    segments: closeEdge([{ text: "│ ", color: C.borderDim }, { text: hint2, color: C.gray }], snap.cols),
  });
  rows.push(boxBottom(snap.cols));
  return { rows, regions };
}

function receiveView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  const copyBtn = `[${t("ui.copyAddress")}]`;
  rows.push(boxTop(snap.cols, t("receive.title")));
  rows.push({
    text: `${snap.address} ${copyBtn}`,
    segments: closeEdge([
      { text: snap.address, bold: true, color: C.cyan },
      { text: " ", color: undefined },
      { text: "[", color: C.border, bg: C.bg, bold: true },
      { text: t("ui.copyAddress"), color: C.fg, bg: C.bg, bold: true },
      { text: "]", color: C.border, bg: C.bg, bold: true },
    ], snap.cols),
  });


  const copyX0 = w2(snap.address) + 1;
  regions.push({ y: 1, x0: copyX0, x1: copyX0 + w2(copyBtn) - 1, action: actions.copyAddress });
  rows.push(boxBottom(snap.cols));
  if (snap.copyMsg) rows.push({ text: snap.copyMsg, color: C.fg });
  if (snap.qr && snap.qr.length > 0) {
    const qrW = Math.max(...snap.qr.map((l) => l.length));
    for (const line of snap.qr) {
      const pad = Math.max(0, Math.floor((snap.cols - qrW) / 2));
      rows.push({ text: `${" ".repeat(pad)}${line}`, dim: true });
    }
  }
  const b = btn(rows.length, 0, `[${t("ui.refresh")}]`, actions.refresh);
  rows.push(b.row);
  regions.push(b.region);

  const hints: Row[] = [
    { text: t("receive.hint1"), color: C.gray },
    { text: t("receive.hint2"), color: C.gray },
  ];
  const contentH = Math.max(2, snap.mainH - hints.length);
  const total = rows.length;
  const start = Math.min(snap.scroll, Math.max(0, total - contentH));
  return {
    rows: [...rows.slice(start, start + contentH), ...hints],
    regions: regions
      .filter((r) => r.y >= start && r.y < start + contentH)
      .map((r) => ({ ...r, y: r.y - start })),
  };
}
function historyView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  rows.push(sectionHeader(t("history.title")));
  const maxRows = Math.max(1, snap.mainH - 2);
  if (snap.txs.length === 0) {
    rows.push({ text: t("history.empty"), color: C.gray });
    return { rows, regions };
  }
  rows.push({
    text: `${padCJK(t("history.colTime"), 12)}${padCJK(t("history.colType"), 4)}${padCJK(t("history.colAmount"), 11)}${padCJK(t("history.colFee"), 9)}${padCJK(t("history.colStatus"), 7)}${padCJK(t("history.colConfirm"), 4)}txid`,
    color: C.grayDim,
  });
  const start = Math.max(0, Math.min(snap.scroll, snap.txs.length - maxRows));
  const visible = snap.txs.slice(start, start + maxRows);
  visible.forEach((tx, i) => {
    const time = new Date(tx.time * 1000).toLocaleString(currentLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const amount = `${tx.category === "send" ? "-" : "+"}${trimEDX(tx.amount)}`;

    const typeColor = tx.type === "mining" ? C.amber : tx.category === "receive" ? C.fg : C.red;
    const amountColor = tx.category === "send" ? C.red : C.fg;
    const statusLabel = txStatusLabel(tx);
    const statusColor = tx.failed ? C.red : tx.status === "pending" || (tx.matureAtHeight !== null && tx.confirmations - 1 < MINING_MATURITY_CONFIRMATIONS) ? C.amber : C.fg;
    const text = `${padCJK(time, 12)}${padCJK(txTypeLabel(tx), 4)}${padCJK(amount, 11)}${padCJK(trimEDX(tx.fee), 9)}${padCJK(txStatusLabel(tx), 7)}${padCJK(txConfirmText(tx), 4)}${truncateMiddle(tx.txid, 12)}`;
    rows.push({
      text,
      segments: [
        { text: padCJK(time, 12), color: C.grayDim },
        { text: padCJK(txTypeLabel(tx), 4), color: typeColor, bold: true },
        { text: padCJK(amount, 11), color: amountColor, bold: true },
        { text: padCJK(trimEDX(tx.fee), 9), color: C.gray },
        { text: padCJK(statusLabel, 7), color: statusColor },
        { text: padCJK(txConfirmText(tx), 4), color: C.gray },
        { text: truncateMiddle(tx.txid, 12), color: C.gray },
      ],
    });
    regions.push({ y: 2 + i, x0: 0, x1: snap.cols - 1, action: () => actions.showTx(tx.txid) });
  });
  if (snap.txs.some((t) => t.matureAtHeight !== null)) {
    rows.push({ text: t("history.maturityHint", { n: MINING_MATURITY_CONFIRMATIONS }), color: C.gray });
  }
  if (snap.txs.length > maxRows) {
    rows.push({ text: t("history.paging", { start: start + 1, end: start + visible.length, total: snap.txs.length }), color: C.gray });
  }
  return { rows, regions };
}

function networkView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  rows.push(sectionHeader(t("network.title")));
  rows.push({ text: t("network.p2p", { a: snap.connectedNodes, b: snap.totalNodes }), color: snap.connectedNodes > 0 ? C.fg : C.red, bold: true });
  rows.push({ text: t("network.hashrate", { hashrate: formatNumber(snap.chain?.networkPower ?? 0) }), color: C.gray });
  rows.push({ text: snap.selfP2pUrl ? t("network.self", { url: snap.selfP2pUrl }) : t("network.selfHidden"), color: C.cyan });
  rows.push({ text: t("network.list"), color: C.gray });
  for (const line of snap.peersText.split("\n")) rows.push({ text: `  ${line}`, color: C.gray });
  const b1 = btn(rows.length, 0, `[${t("network.reconnect")}]`, actions.reconnect);
  const b2 = btn(rows.length, 8, `[${t("ui.refresh")}]`, actions.refresh);
  rows.push({
    text: `${b1.row.text} ${b2.row.text}`,
    segments: [
      ...b1.row.segments!,
      { text: " ", color: undefined },
      ...b2.row.segments!,
    ],
  });
  regions.push(b1.region, b2.region);
  return { rows, regions };
}

function feesView(snap: ViewSnapshot, actions: ViewActions): ViewResult {
  const rows: Row[] = [];
  const regions: Region[] = [];
  rows.push(sectionHeader(t("fees.title")));
  const fees = snap.fees;
  if (!fees) {
    rows.push({ text: t("fees.loading"), color: C.gray });
    const b = btn(rows.length, 0, `[${t("ui.refresh")}]`, actions.refresh);
    rows.push(b.row);
    regions.push(b.region);
    return { rows, regions };
  }
  rows.push({
    text: `${t("fees.line")}slow ${trimEDX(fees.slow)} | normal ${trimEDX(fees.normal)} | fast ${trimEDX(fees.fast)} ${COIN_TICKER}`,
    segments: [
      { text: t("fees.line"), color: C.grayDim },
      { text: `slow ${trimEDX(fees.slow)} `, color: C.dim },
      { text: "| ", color: C.grayDim },
      { text: `normal ${trimEDX(fees.normal)} `, color: C.fg, bold: true },
      { text: "| ", color: C.grayDim },
      { text: `fast ${trimEDX(fees.fast)} ${COIN_TICKER}`, color: C.amber, bold: true },
    ],
  });
  rows.push({ text: t("fees.recommended", { tier: fees.recommended ?? "-", n: typeof fees.pendingCount === "number" ? fees.pendingCount : "-" }), color: C.amber });
  rows.push({ text: t("fees.hint"), color: C.gray });
  if (snap.copyMsg) rows.push({ text: snap.copyMsg, color: C.fg });
  const b = btn(rows.length, 0, `[${t("ui.refresh")}]`, actions.refresh);
  rows.push(b.row);
  regions.push(b.region);
  return { rows, regions };
}

function logsView(snap: ViewSnapshot): ViewResult {
  const rows: Row[] = [];
  rows.push(sectionHeader(t("logs.title")));
  const total = snap.logs.length;
  if (total === 0) {
    rows.push({ text: t("logs.empty"), color: C.gray });
    return { rows, regions: [] };
  }


  const logViewH = Math.max(1, snap.mainH - 1);
  const overflow = total > logViewH;
  const viewH = overflow ? Math.max(1, logViewH - 1) : logViewH;
  const back = Math.min(snap.scroll, Math.max(0, total - viewH));
  const end = total - back;
  const start = Math.max(0, end - viewH);
  for (const line of snap.logs.slice(start, end)) {
    const time = new Date(line.ts).toLocaleTimeString(currentLocale(), { hour12: false });
    const level = line.level.toUpperCase();
    const color = line.level === "error" ? C.red : line.level === "warn" ? C.amber : C.dim;
    rows.push({
      text: `[${time}] [${level}] ${line.message}`,
      segments: [
        { text: `[${time}] `, color: C.grayDim },
        { text: `[${level}] `, color, bold: line.level !== "info" },
        { text: line.message, color },
      ],
    });
  }
  if (overflow) {
    rows.push({ text: t("logs.paging", { start: start + 1, end, total }), color: C.gray });
  }
  return { rows, regions: [] };
}


function wrapRowToWidth(segs: RowSegment[], maxW: number): RowSegment[][] {

  if (segs.reduce((n, s) => n + w2(s.text), 0) <= maxW) return [segs];
  const lines: RowSegment[][] = [];
  let cur: RowSegment[] = [];
  let w = 0;
  const flush = () => {
    if (cur.length > 0) {
      lines.push(cur);
      cur = [];
      w = 0;
    }
  };
  for (const seg of segs) {
    for (const ch of seg.text) {
      const cwch = w2(ch);
      if (w + cwch > maxW && w > 0) flush();
      cur.push({ ...seg, text: ch });
      w += cwch;
    }
  }
  flush();
  return lines;
}







export function buildCommandView(sessions: SessionItem[], logs: LogLine[], cmdScroll: number, mainH: number, cols = 80): ViewResult {
  const rows: Row[] = [];
  if (sessions.length === 0 && logs.length === 0) {
    rows.push({ text: t("cmd.title"), color: C.fg, bold: true });
    rows.push({ text: t("cmd.hint"), color: C.gray });
    return { rows, regions: [] };
  }
  const allLines: Row[] = [];

  const entries: { ts: number; kind: "session" | "log"; session?: SessionItem; log?: LogLine }[] = [
    ...sessions.map((s) => ({ ts: s.ts, kind: "session" as const, session: s })),
    ...logs.map((l) => ({ ts: l.ts, kind: "log" as const, log: l })),
  ].sort((a, b) => a.ts - b.ts);
  for (const e of entries) {
    if (e.kind === "session" && e.session) {
      const s = e.session;
      allLines.push({ text: `> ${s.line}`, bold: true, color: C.fg });
      for (const out of s.output) allLines.push({ text: out });
    } else if (e.log) {
      const l = e.log;
      const time = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false });
      const level = l.level.toUpperCase();
      const color = l.level === "error" ? C.red : l.level === "warn" ? C.amber : C.dim;
      allLines.push({
        text: `[${time}] [${level}] ${l.message}`,
        segments: [
          { text: `[${time}] `, color: C.grayDim },
          { text: `[${level}] `, color, bold: l.level !== "info" },
          { text: l.message, color },
        ],
      });
    }
  }
  const displayLines: Row[] = [];
  for (const row of allLines) {
    const segs = row.segments ?? [{ text: row.text, color: row.color, dim: row.dim, bold: row.bold }];
    for (const lineSegs of wrapRowToWidth(segs, cols)) {
      displayLines.push({ text: lineSegs.map((s) => s.text).join(""), segments: lineSegs });
    }
  }
  const total = displayLines.length;
  const hasFooter = total > mainH;
  const viewH = hasFooter ? Math.max(1, mainH - 1) : mainH;
  const back = Math.min(cmdScroll, Math.max(0, total - viewH));
  const end = total - back;
  const start = Math.max(0, end - viewH);
  rows.push(...displayLines.slice(start, end));
  if (hasFooter) {
    rows.push({ text: t("cmd.paging", { start: start + 1, end, total }), color: C.gray });
  }
  return { rows, regions: [] };
}

export function buildView(view: ViewName, snap: ViewSnapshot, actions: ViewActions): ViewResult {
  switch (view) {
    case "balance":
      return balanceView(snap, actions);
    case "send":
      return sendView(snap, actions);
    case "receive":
      return receiveView(snap, actions);
    case "history":
      return historyView(snap, actions);
    case "network":
      return networkView(snap, actions);
    case "fees":
      return feesView(snap, actions);
    case "logs":
      return logsView(snap);
  }
}
