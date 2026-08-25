import { TABS, type FocusTarget, type SendDraft, type UiMode, type ViewName } from "./views";






export interface InputState {
  focus: FocusTarget;

  row: number;
  command: string;
  cmdHistory: string[];
  cmdIndex: number | null;
  draft: SendDraft;
  dialogOpen: boolean;
  scroll: number;

  requirePassword: boolean;

  mode: UiMode;

  view: ViewName;

  dialogSel: "confirm" | "cancel";

  dialogOptions: number;

  dialogOptionSel: number;

  askActive: boolean;
}


export interface KeyLike {
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export type InputEffect =
  | { kind: "none" }
  | { kind: "runCommand"; line: string }
  | { kind: "exit" }
  | { kind: "dialogConfirm" }
  | { kind: "dialogCancel" }
  | { kind: "toggleMouse" }
  | { kind: "toggleMode" }
  | { kind: "switchView"; name: ViewName }
  | { kind: "focusField"; field: "to" | "amount" | "fee"; row?: number }
  | { kind: "submitSend" }
  | { kind: "resetSend" }
  | { kind: "addRow" }
  | { kind: "delRow" }
  | { kind: "activateFirstRegion" }
  | { kind: "askSubmit"; value: string }
  | { kind: "askCancel" };





const MOUSE_REMNANT_RE = /^\[<[0-9;]*[Mm]?$/;


const SGR_FULL_RE = /\x1b\[<[0-9;]*[Mm]/g;

const SGR_REMNANT_RE = /\[<[0-9;]*[Mm]/g;

export type InputOp = { kind: "text"; ch: string } | { kind: "del" };

export interface NormalizedInput {

  ops: InputOp[];

  hasEsc: boolean;

  hasReturn: boolean;
}










export function normalizeInput(input: string): NormalizedInput {
  const hasReturn = input.endsWith("\r") || input.endsWith("\n");
  const withoutSgr = input.replace(SGR_FULL_RE, "").replace(SGR_REMNANT_RE, "");
  const ops: InputOp[] = [];
  let hasEsc = false;
  for (const ch of withoutSgr) {
    const c = ch.codePointAt(0)!;
    if (ch === "\x7f" || ch === "\x08") {
      ops.push({ kind: "del" });
      continue;
    }
    if (c < 32 || c === 127) {
      if (c === 27) hasEsc = true;
      continue;
    }
    ops.push({ kind: "text", ch });
  }
  return { ops, hasEsc, hasReturn };
}


export function applyNormalized(current: string, norm: NormalizedInput, max: number): string {
  let next = current;
  for (const op of norm.ops) {
    if (op.kind === "del") next = next.slice(0, -1);
    else next = (next + op.ch).slice(0, max);
  }
  return next;
}


function recipientKey(field: "to" | "amount"): "address" | "amount" {
  return field === "to" ? "address" : "amount";
}


function nextFocus(state: InputState): { focus: FocusTarget; row: number } {
  const { focus, row } = state;
  switch (focus) {
    case "to":
      return { focus: "amount", row };
    case "amount":
      return row + 1 < state.draft.recipients.length
        ? { focus: "to", row: row + 1 }
        : { focus: "fee", row };
    case "fee":
      return { focus: "sendBtn", row };
    case "sendBtn":
      return { focus: "resetBtn", row };
    case "resetBtn":
      return { focus: "addRow", row };
    case "addRow":
      return { focus: "delRow", row };
    default:
      return { focus: "command", row: 0 };
  }
}


function prevFocus(state: InputState): { focus: FocusTarget; row: number } {
  const { focus, row } = state;
  switch (focus) {
    case "to":
      return row > 0 ? { focus: "amount", row: row - 1 } : { focus: "command", row: 0 };
    case "amount":
      return { focus: "to", row };
    case "fee":
      return { focus: "amount", row: Math.max(0, state.draft.recipients.length - 1) };
    case "sendBtn":
      return { focus: "fee", row };
    case "resetBtn":
      return { focus: "sendBtn", row };
    case "addRow":
      return { focus: "resetBtn", row };
    case "delRow":
      return { focus: "addRow", row };
    default:
      return { focus: "command", row: 0 };
  }
}

const BUTTON_ORDER: FocusTarget[] = ["sendBtn", "resetBtn", "addRow", "delRow"];

export function reduceInput(
  state: InputState,
  input: string,
  key: KeyLike,
): { state: InputState; effect: InputEffect } {

  if (normalizeInput(input).hasEsc) return { state, effect: { kind: "none" } };

  if (MOUSE_REMNANT_RE.test(input)) return { state, effect: { kind: "none" } };
  if (key.ctrl && input.toLowerCase() === "c") return { state, effect: { kind: "exit" } };

  if (key.ctrl && input.toLowerCase() === "t") return { state, effect: { kind: "toggleMouse" } };

  if (key.ctrl && input.toLowerCase() === "b") return { state, effect: { kind: "toggleMode" } };


  if (state.dialogOpen) {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      if (state.dialogOptions > 0) {
        const delta = key.rightArrow || key.downArrow ? 1 : -1;
        const sel = (state.dialogOptionSel + delta + state.dialogOptions) % state.dialogOptions;
        return { state: { ...state, dialogOptionSel: sel }, effect: { kind: "none" } };
      }
      return {
        state: { ...state, dialogSel: state.dialogSel === "confirm" ? "cancel" : "confirm" },
        effect: { kind: "none" },
      };
    }
    if (key.return) return { state, effect: { kind: "dialogConfirm" } };
    if (key.escape) return { state, effect: { kind: "dialogCancel" } };
    return { state, effect: { kind: "none" } };
  }


  if (state.focus === "to" || state.focus === "amount" || state.focus === "fee") {
    const field = state.focus;
    if (key.backspace || key.delete) {
      if (field === "to" || field === "amount") {
        const keyField = recipientKey(field);
        const recipients = state.draft.recipients.map((r, i) =>
          i === state.row ? { ...r, [keyField]: r[keyField].slice(0, -1) } : r,
        );
        return {
          state: { ...state, draft: { ...state.draft, recipients } },
          effect: { kind: "none" },
        };
      }
      return {
        state: { ...state, draft: { ...state.draft, [field]: state.draft[field].slice(0, -1) } },
        effect: { kind: "none" },
      };
    }
    if (key.escape) return { state: { ...state, focus: "command", row: 0 }, effect: { kind: "none" } };

    if ((key.tab && key.shift) || key.upArrow) {
      const prev = prevFocus(state);
      return { state: { ...state, focus: prev.focus, row: prev.row }, effect: { kind: "none" } };
    }

    if (key.downArrow || key.tab || key.return) {
      const next = nextFocus(state);
      return { state: { ...state, focus: next.focus, row: next.row }, effect: { kind: "none" } };
    }
    if (input && !key.ctrl) {
      const norm = normalizeInput(input);
      if (norm.hasEsc) return { state, effect: { kind: "none" } };
      if (norm.ops.length === 0) return { state, effect: { kind: "none" } };
      if (field === "to" || field === "amount") {
        const keyField = recipientKey(field);
        const recipients = state.draft.recipients.map((r, i) =>
          i === state.row ? { ...r, [keyField]: applyNormalized(r[keyField], norm, 80) } : r,
        );
        return {
          state: { ...state, draft: { ...state.draft, recipients } },
          effect: { kind: "none" },
        };
      }
      return {
        state: { ...state, draft: { ...state.draft, [field]: applyNormalized(state.draft[field], norm, 80) } },
        effect: { kind: "none" },
      };
    }
    return { state, effect: { kind: "none" } };
  }


  if (state.focus === "sendBtn" || state.focus === "resetBtn" || state.focus === "addRow" || state.focus === "delRow") {
    const index = BUTTON_ORDER.indexOf(state.focus);
    if (key.leftArrow || key.rightArrow) {
      const delta = key.rightArrow ? 1 : -1;
      const next = BUTTON_ORDER[(index + delta + BUTTON_ORDER.length) % BUTTON_ORDER.length];
      return { state: { ...state, focus: next }, effect: { kind: "none" } };
    }
    if (key.return) {
      const effect: InputEffect =
        state.focus === "sendBtn"
          ? { kind: "submitSend" }
          : state.focus === "resetBtn"
            ? { kind: "resetSend" }
            : state.focus === "addRow"
              ? { kind: "addRow" }
              : { kind: "delRow" };
      return { state, effect };
    }
    if (key.escape) return { state: { ...state, focus: "command", row: 0 }, effect: { kind: "none" } };

    if ((key.tab && key.shift) || key.upArrow) {
      const prev = prevFocus(state);
      return { state: { ...state, focus: prev.focus, row: prev.row }, effect: { kind: "none" } };
    }

    if (key.tab || key.downArrow) {
      const next = nextFocus(state);
      return { state: { ...state, focus: next.focus, row: next.row }, effect: { kind: "none" } };
    }
    return { state, effect: { kind: "none" } };
  }


  if (state.mode === "command") {

    if (state.askActive) {
      if (key.escape) {
        return { state: { ...state, command: "", askActive: false }, effect: { kind: "askCancel" } };
      }
      if (key.return) {
        const value = state.command;
        return { state: { ...state, command: "", askActive: false }, effect: { kind: "askSubmit", value } };
      }
      if (key.backspace || key.delete) {
        return { state: { ...state, command: state.command.slice(0, -1) }, effect: { kind: "none" } };
      }
      if (input && !key.ctrl) {
        const norm = normalizeInput(input);
        if (norm.hasEsc) return { state, effect: { kind: "none" } };
        if (norm.ops.length === 0 && !norm.hasReturn) return { state, effect: { kind: "none" } };
        const command = applyNormalized(state.command, norm, 200);

        if (norm.hasReturn) {
          return {
            state: { ...state, command: "", askActive: false },
            effect: { kind: "askSubmit", value: command },
          };
        }
        return { state: { ...state, command }, effect: { kind: "none" } };
      }
      return { state, effect: { kind: "none" } };
    }
    if (key.pageUp) return { state: { ...state, scroll: state.scroll + 5 }, effect: { kind: "none" } };
    if (key.pageDown) return { state: { ...state, scroll: Math.max(0, state.scroll - 5) }, effect: { kind: "none" } };
    if (key.backspace || key.delete) return { state: { ...state, command: state.command.slice(0, -1) }, effect: { kind: "none" } };
    if (key.escape) return { state: { ...state, command: "" }, effect: { kind: "none" } };
    if (key.return) {
      const line = state.command;
      if (line.trim() === "") return { state, effect: { kind: "none" } };
      return {
        state: { ...state, command: "", cmdHistory: [...state.cmdHistory, line], cmdIndex: null },
        effect: { kind: "runCommand", line },
      };
    }
    if (key.upArrow) {
      const next = (state.cmdIndex ?? state.cmdHistory.length) - 1;
      if (next < 0) return { state, effect: { kind: "none" } };
      return { state: { ...state, cmdIndex: next, command: state.cmdHistory[next] ?? "" }, effect: { kind: "none" } };
    }
    if (key.downArrow) {
      const next = (state.cmdIndex ?? state.cmdHistory.length) + 1;
      if (next > state.cmdHistory.length) return { state, effect: { kind: "none" } };
      return {
        state: {
          ...state,
          cmdIndex: next === state.cmdHistory.length ? null : next,
          command: next === state.cmdHistory.length ? "" : (state.cmdHistory[next] ?? ""),
        },
        effect: { kind: "none" },
      };
    }
    if (input && !key.ctrl) {
      const norm = normalizeInput(input);
      if (norm.hasEsc) return { state, effect: { kind: "none" } };
      if (norm.ops.length === 0 && !norm.hasReturn) return { state, effect: { kind: "none" } };
      const command = applyNormalized(state.command, norm, 200);

      if (norm.hasReturn) {
        if (command.trim() === "") return { state, effect: { kind: "none" } };
        return {
          state: { ...state, command: "", cmdHistory: [...state.cmdHistory, command], cmdIndex: null },
          effect: { kind: "runCommand", line: command },
        };
      }
      return { state: { ...state, command }, effect: { kind: "none" } };
    }
    return { state, effect: { kind: "none" } };
  }


  const tabIndex = TABS.findIndex((t) => t.name === state.view);
  const baseIndex = tabIndex < 0 ? 0 : tabIndex;

  if (key.leftArrow) {
    return { state, effect: { kind: "switchView", name: TABS[(baseIndex - 1 + TABS.length) % TABS.length].name } };
  }
  if (key.rightArrow) {
    return { state, effect: { kind: "switchView", name: TABS[(baseIndex + 1) % TABS.length].name } };
  }


  if (key.upArrow)
    return {
      state: { ...state, scroll: state.view === "logs" ? state.scroll + 1 : Math.max(0, state.scroll - 1) },
      effect: { kind: "none" },
    };
  if (key.downArrow)
    return {
      state: { ...state, scroll: state.view === "logs" ? Math.max(0, state.scroll - 1) : state.scroll + 1 },
      effect: { kind: "none" },
    };

  if (key.pageUp)
    return {
      state: { ...state, scroll: state.view === "logs" ? state.scroll + 5 : Math.max(0, state.scroll - 5) },
      effect: { kind: "none" },
    };
  if (key.pageDown)
    return {
      state: { ...state, scroll: state.view === "logs" ? Math.max(0, state.scroll - 5) : state.scroll + 5 },
      effect: { kind: "none" },
    };

  if (key.return) {
    if (state.view === "send") {
      const recipients = state.draft.recipients;
      const firstIncomplete = recipients.findIndex((r) => r.address.trim() === "" || r.amount.trim() === "");
      if (firstIncomplete >= 0) {
        const row = Math.max(0, firstIncomplete);
        const focus: FocusTarget = recipients[row].address.trim() === "" ? "to" : "amount";
        return { state: { ...state, row, focus }, effect: { kind: "none" } };
      }

      return { state: { ...state, focus: "sendBtn", row: Math.max(0, recipients.length - 1) }, effect: { kind: "none" } };
    }
    return { state, effect: { kind: "activateFirstRegion" } };
  }

  if (key.tab && state.view === "send") return { state: { ...state, row: 0, focus: "to" }, effect: { kind: "none" } };

  return { state, effect: { kind: "none" } };
}
