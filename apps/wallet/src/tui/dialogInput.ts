import { applyNormalized, normalizeInput } from "./inputReducer";


export function nextDialogPassword(
  prev: string,
  input: string,
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean; backspace?: boolean; delete?: boolean },
): string {
  if (key.ctrl || key.meta) return prev;
  if (key.backspace || key.delete) return prev.slice(0, -1);
  if (input === "") return prev;
  const norm = normalizeInput(input);
  if (norm.hasEsc) return prev;
  return applyNormalized(prev, norm, 64);
}
