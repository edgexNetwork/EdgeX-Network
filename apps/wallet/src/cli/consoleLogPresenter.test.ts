import { describe, expect, test } from "bun:test";
import { createLogPresenter, formatLogLine, hasPendingInput } from "./consoleSession";

const TS = new Date(2026, 0, 2, 3, 4, 5).getTime();

function flushAll(presenter: ReturnType<typeof createLogPresenter>): void {
  // The presenter schedules a flush on a microtask; await a turn so it runs.
  presenter.flush();
}

function collect() {
  const emitted: string[] = [];
  return { emitted };
}

describe("formatLogLine", () => {
  test("mirrors the Logger console style with level labels", () => {
    expect(formatLogLine(TS, "info", "hello")).toBe("[03:04:05] [INFO] hello");
    expect(formatLogLine(TS, "error", "boom")).toBe("[03:04:05] [ERR ] boom");
    expect(formatLogLine(TS, "warn", "careful")).toBe("[03:04:05] [WARN] careful");
    expect(formatLogLine(TS, "debug", "trace")).toBe("[03:04:05] [DBG ] trace");
  });
});

describe("hasPendingInput", () => {
  test("detects unsubmitted input on a readline-like object", () => {
    expect(hasPendingInput(null)).toBe(false);
    expect(hasPendingInput({})).toBe(false);
    expect(hasPendingInput({ line: "par" })).toBe(true);
    expect(hasPendingInput({ line: "" })).toBe(false);
  });
});

describe("createLogPresenter", () => {
  test("non-TTY emits log lines directly without clearing or redrawing", () => {
    const { emitted } = collect();
    const presenter = createLogPresenter({
      emit: (l) => emitted.push(l),
      redraw: () => emitted.push("__redraw__"),
      isTty: false,
    });
    presenter.push(TS, "info", "one");
    presenter.push(TS, "warn", "two");
    flushAll(presenter);
    expect(emitted).toEqual(["[03:04:05] [INFO] one", "[03:04:05] [WARN] two"]);
  });

  test("TTY batches a microtask burst and redraws after emitting", () => {
    const { emitted } = collect();
    let clears = 0;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const presenter = createLogPresenter({
      emit: (l) => emitted.push(l),
      redraw: () => emitted.push("__redraw__"),
      isTty: true,
      clearLine: () => {
        clears += 1;
        return true;
      },
    });
    presenter.push(TS, "info", "one");
    presenter.push(TS, "info", "two");
    flushAll(presenter);
    originalWrite(""); // silence unused binding
    expect(clears).toBe(1);
    expect(emitted).toEqual(["[03:04:05] [INFO] one", "[03:04:05] [INFO] two", "__redraw__"]);
  });

  test("quiet periods buffer logs until the quiet gate opens", () => {
    const { emitted } = collect();
    let quiet = true;
    const presenter = createLogPresenter({
      emit: (l) => emitted.push(l),
      redraw: () => emitted.push("__redraw__"),
      isTty: false,
      isQuiet: () => quiet,
    });
    presenter.push(TS, "info", "during-command");
    flushAll(presenter);
    expect(emitted).toEqual([]);
    quiet = false;
    presenter.flush();
    expect(emitted).toEqual(["[03:04:05] [INFO] during-command"]);
  });

  test("clearLine=false prevents wiping the line (secret entry)", () => {
    const { emitted } = collect();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let clears = 0;
    const presenter = createLogPresenter({
      emit: (l) => emitted.push(l),
      redraw: () => emitted.push("__redraw__"),
      isTty: true,
      clearLine: () => {
        clears += 1;
        return false;
      },
    });
    presenter.push(TS, "info", "secret-era");
    flushAll(presenter);
    originalWrite("");
    expect(clears).toBe(1);
    // When the clear is suppressed the presenter still emits + redraws.
    expect(emitted).toEqual(["[03:04:05] [INFO] secret-era", "__redraw__"]);
  });
});
