import type { CommandRegistry, CommandContext } from "../commands/registry";
import type { Logger } from "../utils/log";
import { t } from "../i18n";
import { promptLine, promptSecret } from "../keys/vaultLegacy";

/**
 * Classification of one raw console input line.
 * - Empty lines and lines starting with "#" are ignored.
 * - "exit" / "quit" (case-insensitive) end the session.
 * - Anything else is handed to the command registry.
 */
export type ConsoleRoute =
  | { kind: "skip" }
  | { kind: "exit" }
  | { kind: "command"; text: string };

export function routeConsoleInput(raw: string): ConsoleRoute {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return { kind: "skip" };
  const lower = trimmed.toLowerCase();
  if (lower === "exit" || lower === "quit") return { kind: "exit" };
  return { kind: "command", text: trimmed };
}

export interface ConsoleSessionOptions {
  /** Called once per output line produced by the session. */
  write: (line: string) => void;
  /** Prompt text drawn before each command line. */
  prompt?: string;
  /** Cleanup hook invoked after the session ends (core/RPC shutdown). */
  onExit?: () => void;
}

/**
 * A line-oriented interactive console that routes each line through the
 * command registry. The session never touches stdin/stdout directly: the
 * caller supplies the next line via feed() and receives output through write.
 * This keeps the whole loop unit-testable without a TTY.
 */
export class ConsoleSession {
  private readonly registry: CommandRegistry;
  private readonly ctx: CommandContext;
  private readonly options: ConsoleSessionOptions;
  private ended = false;

  constructor(registry: CommandRegistry, ctx: CommandContext, options: ConsoleSessionOptions) {
    this.registry = registry;
    this.ctx = ctx;
    this.options = options;
  }

  get running(): boolean {
    return !this.ended;
  }

  /** Process one raw input line. Returns true when the session should end. */
  async feed(raw: string): Promise<boolean> {
    const route = routeConsoleInput(raw);
    if (route.kind === "skip") return false;
    if (route.kind === "exit") {
      this.end();
      return true;
    }
    try {
      const output = await this.registry.execute(route.text, this.ctx);
      if (output) this.options.write(output);
    } catch (error) {
      this.options.write(`Error: ${(error as Error).message}`);
    }
    return false;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.options.onExit?.();
  }

  /** Convenience banner printed when the session starts. */
  banner(): void {
    this.options.write(this.registry.helpText());
  }
}

/** Log-level label, matching the Logger console output (ERR/WARN/DBG/INFO). */
function logLabel(level: string): string {
  return level === "error" ? "ERR " : level === "warn" ? "WARN" : level === "debug" ? "DBG " : "INFO";
}

/** Format one system log line in the same style as the Logger console output:
 *  [HH:MM:SS] [LABEL] message. Exported for unit tests. */
export function formatLogLine(ts: number, level: string, message: string): string {
  const time = new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  return `[${time}] [${logLabel(level)}] ${message}`;
}

/** Whether the readline instance currently holds unsubmitted input (the user
 *  typed characters but has not pressed Enter yet). Exported for unit tests. */
export function hasPendingInput(rl: unknown): boolean {
  if (!rl) return false;
  const line = (rl as { line?: string }).line;
  return typeof line === "string" && line.length > 0;
}

export interface LogPresenterHooks {
  /** Emit one formatted line (log or plain output). */
  emit: (line: string) => void;
  /** Redraw the prompt after a log burst (TTY only). */
  redraw: () => void;
  /** True when stdin/stdout are TTYs: logs clear the current line and redraw.
   *  When false (pipe/script) log lines are emitted directly. */
  isTty: boolean;
  /** Whether to clear the current line before emitting (false while a secret
   *  is being typed so an in-progress password is never wiped). Default true. */
  clearLine?: () => boolean;
  /** Quiet-period gate: while true, incoming logs are buffered instead of
   *  written, so a log burst never lands between the prompt and the user's
   *  input (command running / secret input / unsubmitted text). */
  isQuiet?: () => boolean;
}

/**
 * System-log presenter: batches log lines arriving from the Logger sink within
 * the same microtask and lays them out around the interactive prompt.
 * - TTY: each batch clears the current line (`\r\x1b[K`), emits, then redraws
 *   the prompt, so a mid-input log line never pushes the prompt sideways.
 * - non-TTY: lines are emitted directly (see the driver note below).
 * - Quiet periods (isQuiet): lines are accumulated and flushed when the quiet
 *   period ends, so logs never interrupt an in-progress command or secret.
 */
export function createLogPresenter(hooks: LogPresenterHooks): {
  push: (ts: number, level: string, message: string) => void;
  flush: () => void;
} {
  let batch: string[] | null = null;
  let scheduled = false;

  const emitLines = (lines: string[]) => {
    if (hooks.isTty) {
      // Clear the current prompt line (the readline line buffer is untouched);
      // skipped while a secret is being typed so the password display survives.
      const clear = hooks.clearLine?.() ?? true;
      if (clear) process.stdout.write("\r\x1b[K");
      for (const line of lines) hooks.emit(line);
      hooks.redraw();
    } else {
      for (const line of lines) hooks.emit(line);
    }
  };

  const flush = () => {
    scheduled = false;
    const lines = batch;
    batch = null;
    if (!lines || lines.length === 0) return;
    if (hooks.isQuiet?.()) {
      // Still inside a quiet period: hold the lines for the next flush.
      batch = lines;
      return;
    }
    emitLines(lines);
  };

  return {
    push(ts, level, message) {
      if (!batch) batch = [];
      batch.push(formatLogLine(ts, level, message));
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    flush,
  };
}

/**
 * Terminal driver used by the real entry point.
 *
 * - TTY: one resident node:readline instance executes commands line by line.
 *   While a command runs or a secret is typed, the readline interface stays
 *   alive; in-band log lines are batched by the presenter and only written in
 *   the quiet gaps, clearing the prompt line first and redrawing afterwards so
 *   the user's input is never visually corrupted.
 * - non-TTY (pipe/script): commands are read line by line through the shared
 *   stdin line pump (the same pump promptSecret uses for hidden input in
 *   piped mode), so command lines and password responses are consumed in
 *   order and never race each other. The presenter's non-TTY branch emits log
 *   lines directly to the write callback - for a daemon-style consumer the
 *   Logger console output is already off (see the entry point), so this stays
 *   deterministic.
 */
export function runConsoleWithReadline(
  registry: CommandRegistry,
  ctx: CommandContext,
  log: Logger,
  options: ConsoleSessionOptions,
): Promise<void> {
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const out = options.write;

  if (!isTty) {
    // Pipe-driven session. Commands and password prompts share the stdin pump,
    // so they are consumed strictly in arrival order.
    const session = new ConsoleSession(registry, ctx, options);
    session.banner();
    return new Promise<void>((resolve) => {
      const run = async () => {
        while (session.running) {
          const line = await promptLine("");
          if (!session.running) break;
          if (line === "") continue;
          const shouldEnd = await session.feed(line);
          if (shouldEnd) {
            resolve();
            return;
          }
        }
        resolve();
      };
      void run();
    });
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: options.prompt ?? "edx> " });

    // Password confirmation must read in raw mode without echo; the readline
    // interface is paused for the duration and resumed afterwards so no input
    // is double-consumed by the two readers.
    const interactiveContext: CommandContext = {
      ...ctx,
      interactive: true,
      askSecret: async (promptText) => {
        readingSecret = true;
        rl.pause();
        try {
          const password = await promptSecret(promptText);
          // promptSecret switches the terminal out of raw mode when it ends;
          // the readline terminal driver relies on raw mode, so restore it.
          if (typeof process.stdin.setRawMode === "function") {
            try {
              process.stdin.setRawMode(true);
            } catch {
              // Non-TTY or unsupported terminal: ignore raw-mode failures.
            }
          }
          return password;
        } finally {
          readingSecret = false;
          rl.resume();
          rl.prompt();
        }
      },
    };

    const session = new ConsoleSession(registry, interactiveContext, {
      ...options,
      onExit: () => {
        options.onExit?.();
        resolve();
      },
    });

    let busy = false;
    let readingSecret = false;

    // Mid-command log lines would corrupt the prompt line; the presenter
    // batches them on a microtask and defers them while the user is typing, a
    // command is running or a secret is being read, then clears, prints and
    // redraws in the quiet gaps.
    const presenter = createLogPresenter({
      emit: out,
      redraw: () => {
        if (!busy && !readingSecret) rl.prompt();
      },
      isTty,
      clearLine: () => !readingSecret,
      isQuiet: () => busy || readingSecret || hasPendingInput(rl),
    });

    const unsubscribe = log.onSink((line) => presenter.push(line.ts, line.level, line.message));

    const flushPendingLogs = () => {
      presenter.flush();
      if (!busy && !readingSecret) rl.prompt();
    };

    // Run one command line. The whole execution window is busy: any logs the
    // command itself produces (or that arrive while it runs) are deferred and
    // flushed after the command returns, so they never land between the user's
    // input and the command's output.
    const runCommand = async (raw: string): Promise<boolean> => {
      busy = true;
      let shouldEnd = false;
      try {
        shouldEnd = await session.feed(raw);
      } finally {
        busy = false;
        flushPendingLogs();
      }
      return shouldEnd;
    };

    session.banner();
    rl.prompt();

    rl.on("line", (raw) => {
      void (async () => {
        // A previous command is still executing (busy) or a secret read is in
        // progress: drop the keystroke; the prompt is redrawn by the running
        // command's completion path.
        if (busy || readingSecret) return;
        // The user's input was submitted: flush any logs that arrived while
        // they were typing (the presenter's microtask may still be pending, so
        // yield a turn first), then run the command.
        await Promise.resolve();
        flushPendingLogs();
        const shouldEnd = await runCommand(raw);
        if (shouldEnd) {
          unsubscribe();
          rl.close();
        }
      })();
    });
    rl.on("close", () => {
      unsubscribe();
      session.end();
    });
    // Ctrl+C redraws the prompt instead of killing the process; Ctrl+D (EOF)
    // ends the session.
    rl.on("SIGINT", () => {
      rl.prompt();
    });
  });
}
