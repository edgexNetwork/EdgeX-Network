import { MINING_MATURITY_CONFIRMATIONS } from "./constants";
import { t } from "../i18n";

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    w += code > 0x2e7f && code < 0x3000 ? 2 : 0x3000 <= code && code <= 0x9fff ? 2 : 1;
  }
  return w;
}

export function formatNumber(n: number | bigint | string): string {
  const s = String(n);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart] = body.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (fracPart ? "." + fracPart : "");
}

export function truncateMiddle(s: string, max = 16): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

export function padCJK(s: string, width: number): string {
  const pad = Math.max(0, width - strWidth(s));
  return s + " ".repeat(pad);
}


export function txTypeLabel(tx: { type: "transfer" | "mining"; category: "send" | "receive"; height?: number | null }): string {
  if (tx.type === "mining") return t("txType.mining");
  return tx.category === "send" ? t("txType.send") : t("txType.receive");
}

export interface TxConfirmLike {
  status: "pending" | "confirmed";
  type: "transfer" | "mining";
  confirmations: number;

  failed?: boolean;

  matureAtHeight: number | null;
}


export function blocksAfterReward(tx: TxConfirmLike): number {
  return Math.max(0, tx.confirmations - 1);
}


export function txMaturityProgress(tx: TxConfirmLike): string | null {
  if (tx.matureAtHeight === null) return null;
  const n = Math.min(blocksAfterReward(tx), MINING_MATURITY_CONFIRMATIONS);
  return `${n}/${MINING_MATURITY_CONFIRMATIONS}`;
}


export function txStatusLabel(tx: TxConfirmLike): string {
  if (tx.failed) return t("txStatus.failed");
  if (tx.status === "pending") return t("txStatus.pending");
  if (tx.matureAtHeight !== null) return blocksAfterReward(tx) >= MINING_MATURITY_CONFIRMATIONS ? t("txStatus.mature") : t("txStatus.immature");
  return t("txStatus.confirmed");
}


export function txConfirmText(tx: TxConfirmLike): string {
  if (tx.status === "pending") return "-";
  return txMaturityProgress(tx) ?? String(tx.confirmations);
}


export function txMaturityLine(tx: TxConfirmLike): string | null {
  const progress = txMaturityProgress(tx);
  if (progress === null) return null;
  if (blocksAfterReward(tx) >= MINING_MATURITY_CONFIRMATIONS) {
    return t("txMaturity.mature", { progress });
  }
  return t("txMaturity.immature", { progress, n: MINING_MATURITY_CONFIRMATIONS });
}
