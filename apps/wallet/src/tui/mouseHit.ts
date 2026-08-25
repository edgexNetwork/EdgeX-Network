import { strWidth } from "../utils/display";
import { t } from "../i18n";


export interface DialogLayout {
  top: number;
  left: number;
  width: number;
  height: number;
  btnRow: number;
  confirmX0: number;
  confirmX1: number;
  cancelX0: number;
  cancelX1: number;
}

export interface DialogLike {
  lines: unknown[];
  confirmText: string;
  cancelText?: string;

  options?: unknown[];

  hideButtons?: boolean;
}








export function computeDialogLayout(
  dialog: DialogLike,
  mainTop: number,
  mainH: number,
  cols: number,
  dialogW = 46,
): DialogLayout {
  const optionRows = dialog.options?.length ?? 0;
  const dialogH = dialog.lines.length + optionRows + (dialog.hideButtons ? 4 : 5);

  const topCentered = mainTop + Math.max(1, Math.floor((mainH - dialogH) / 2));
  const top = Math.max(mainTop, Math.min(topCentered, mainTop + Math.max(0, mainH - dialogH)));
  const left = Math.max(0, Math.floor((cols - dialogW) / 2));
  const btnRow = top + 3 + dialog.lines.length + optionRows;
  const contentX = left + 2;
  const confirmX0 = contentX;
  const confirmX1 = confirmX0 + strWidth(dialog.confirmText) + 2 - 1;
  const cancelX0 = confirmX0 + strWidth(dialog.confirmText) + 2 + 2;
  const cancelX1 = cancelX0 + strWidth(dialog.cancelText ?? t("ui.cancel")) + 2 - 1;
  return { top, left, width: dialogW, height: dialogH, btnRow, confirmX0, confirmX1, cancelX0, cancelX1 };
}


export function hitDialog(layout: DialogLayout, x0: number, y0: number): "confirm" | "cancel" | null {
  if (y0 < layout.top || y0 > layout.btnRow || x0 < layout.left || x0 > layout.left + layout.width) return null;
  if (y0 !== layout.btnRow) return null;
  if (x0 >= layout.confirmX0 && x0 <= layout.confirmX1) return "confirm";
  if (x0 >= layout.cancelX0 && x0 <= layout.cancelX1) return "cancel";
  return null;
}


export function hitTabRow<T extends { label: string }>(
  tabs: readonly T[],
  x0: number,
  tabRowY: number,
  y0: number,
): T | null {
  if (y0 !== tabRowY) return null;
  let x = 0;
  for (const tab of tabs) {


    const w = strWidth(` ${tab.label} `);
    if (x0 >= x && x0 < x + w) return tab;
    x += w;
  }
  return null;
}


export function hitModeButton(cols: number, label: string, x0: number, y0: number): boolean {
  if (y0 !== 1) return false;
  const w = strWidth(label);
  return x0 >= cols - w && x0 < cols;
}


export function hitLangButton(cols: number, langLabel: string, modeLabel: string, x0: number, y0: number): boolean {
  if (y0 !== 1) return false;
  const modeW = strWidth(modeLabel);
  const langW = strWidth(langLabel);
  const start = cols - modeW - 1 - langW;
  return x0 >= start && x0 < start + langW;
}
