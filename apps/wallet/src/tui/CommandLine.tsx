import { Box, Text } from "ink";
import { w2 } from "./views";
import { t } from "../i18n";
import { C } from "./theme";

export interface CommandLineProps {
  value: string;
  focused: boolean;

  prefix?: string;

  masked?: boolean;

  cols?: number;
}



const CURSOR_BLOCK = "█";


export function commandLineText(value: string, prefix: string | undefined, masked: boolean, hint: string | undefined): string {
  const display = masked ? "*".repeat(value.length) : value;
  const pre = `❯ ${prefix !== undefined ? `${prefix} ` : ""}${display}`;
  return hint === undefined ? `${pre}${CURSOR_BLOCK}` : `${pre} ${hint}`;
}


interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
}

function buildSegs(value: string, prefix: string | undefined, masked: boolean, hint: string | undefined): Seg[] {
  const display = masked ? "*".repeat(value.length) : value;
  const segs: Seg[] = [
    { text: "❯", color: hint === undefined ? C.fg : C.gray, bold: true },
    { text: " " },
  ];
  if (prefix !== undefined) segs.push({ text: `${prefix} `, color: C.cyan });
  segs.push({ text: display, color: hint === undefined ? C.white : C.gray });
  if (hint === undefined) {
    segs.push({ text: CURSOR_BLOCK, color: C.cyan });
  } else {
    segs.push({ text: ` ${hint}`, color: C.grayDim });
  }
  return segs;
}







function wrapSegs(segs: Seg[], cols: number): Seg[][] {
  if (cols <= 0) return [[{ text: "" }]];
  const rows: Seg[][] = [];
  let cur: Seg[] = [];
  let w = 0;
  const flush = () => {
    if (cur.length > 0) {
      rows.push(cur);
      cur = [];
      w = 0;
    }
  };
  for (const seg of segs) {
    for (const ch of seg.text) {
      const cwch = w2(ch);
      if (w + cwch > cols && w > 0) flush();
      const prev = cur[cur.length - 1];
      if (prev !== undefined && prev.color === seg.color && prev.bold === seg.bold) {
        prev.text += ch;
      } else {
        cur.push({ ...seg, text: ch });
      }
      w += cwch;
    }
  }
  flush();


  const lastRow = rows[rows.length - 1];
  if (rows.length > 1 && lastRow.length === 1 && lastRow[0].text === CURSOR_BLOCK) {
    const prevRow = rows[rows.length - 2];
    const prevSeg = prevRow[prevRow.length - 1];
    if (prevSeg !== undefined && prevSeg.text !== "") {
      const chars = [...prevSeg.text];
      const ch = chars.pop()!;
      prevSeg.text = prevSeg.text.slice(0, prevSeg.text.length - ch.length);
      if (prevSeg.text === "") prevRow.pop();
      lastRow.unshift({ ...prevSeg, text: ch });
    }
  }
  return rows;
}


export function commandLineRows(value: string, prefix: string | undefined, masked: boolean, hint: string | undefined, cols: number): string[] {
  return wrapSegs(buildSegs(value, prefix, masked, hint), cols).map((row) => row.map((seg) => seg.text).join(""));
}






export function commandLineLines(value: string, prefix: string | undefined, masked: boolean, hint: string | undefined, cols: number): number {
  return commandLineRows(value, prefix, masked, hint, cols).length;
}


export function CommandLine({ value, focused, prefix, masked, cols = 80 }: CommandLineProps) {
  const hint = focused ? undefined : t("cmdline.blurHint");
  const rows = wrapSegs(buildSegs(value, prefix, masked ?? false, hint), cols);
  return (
    <Box width="100%" flexDirection="column">
      {
 }
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {row.map((seg, segIndex) => (
            <Text key={segIndex} color={seg.color} bold={seg.bold}>
              {seg.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}