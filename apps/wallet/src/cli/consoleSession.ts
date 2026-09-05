import type { CommandRegistry, CommandContext } from "../commands/registry";
import type { Logger } from "../utils/log";
import { t } from "../i18n";
import { promptSecret } from "../keys/vaultLegacy";

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

/** Terminal driver used by the real entry point (node:readline based). */
export function runConsoleWithReadline(
  registry: CommandRegistry,
  ctx: CommandContext,
  log: Logger,
  options: ConsoleSessionOptions,
): Promise<void> {
  return new Promise((resolve) => {
    const { createInterface } = require("node:readline") as typeof import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: options.prompt ?? "edx> " });

    // Password confirmation must read in raw mode without echo; the readline
    // interface is paused for the duration and resumed afterwards so no input
    // is double-consumed by the two readers.
    const interactiveContext: CommandContext = {
      ...ctx,
      interactive: true,
      askSecret: async (promptText) => {
        rl.pause();
        try {
          return await promptSecret(promptText);
        } finally {
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
    session.banner();
    rl.prompt();

    // Mid-command log lines would corrupt the prompt line; batch them on a
    // microtask, clear the prompt, print, and redraw.
    let logPaused = false;
    const pendingLogs: string[] = [];
    const flushLogs = () => {
      if (pendingLogs.length === 0) return;
      const batch = pendingLogs.splice(0, pendingLogs.length);
      process.stdout.write("\r\x1b[K");
      for (const message of batch) log.info(message);
      rl.prompt(true);
    };
    const unsubscribe = log.onSink((line) => {
      if (logPaused) return;
      logPaused = true;
      queueMicrotask(() => {
        logPaused = false;
        flushLogs();
      });
    });

    rl.on("line", (raw) => {
      void (async () => {
        const shouldEnd = await session.feed(raw);
        if (shouldEnd) {
          unsubscribe();
          rl.close();
        } else {
          rl.prompt();
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
