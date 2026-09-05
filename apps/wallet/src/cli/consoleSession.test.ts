import { describe, expect, test } from "bun:test";
import { routeConsoleInput, ConsoleSession } from "./consoleSession";
import type { Command, CommandContext } from "../commands/registry";
import { CommandRegistry } from "../commands/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../utils/log";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/** A registry whose commands echo what they receive for easy assertions. */
function stubRegistry(overrides: Record<string, (args: string[], ctx: CommandContext) => Promise<string> | string> = {}): CommandRegistry {
  const registry = new CommandRegistry();
  const echo: Command = {
    name: "echo",
    summary: "echo args",
    usage: "echo <text>",
    run: (args) => args.join(" "),
  };
  const wallet: Command = {
    name: "wallet",
    summary: "sensitive wallet op",
    usage: "wallet",
    run: async (_args, ctx) => {
      if (!ctx.core.requirePassword()) return "no-vault";
      if (ctx.askSecret) {
        const password = await ctx.askSecret("Wallet password: ");
        if (password === "") return "cancelled";
        if (password !== "right") return "Error: Wrong wallet password";
        return "ok";
      }
      return "no-ask";
    },
  };
  registry.register(echo);
  registry.register(wallet);
  for (const [name, run] of Object.entries(overrides)) {
    registry.register({ name, summary: name, usage: name, run });
  }
  return registry;
}

function coreStub(vault: boolean) {
  return { requirePassword: () => vault } as unknown as CommandContext["core"];
}

function ctxStub(vault = false, withSecret = false): CommandContext {
  return {
    core: coreStub(vault),
    log: silentLog,
    interactive: true,
    askSecret: withSecret ? async (prompt) => prompt : undefined,
    datadir: mkdtempSync(join(tmpdir(), "edgex-console-")),
  };
}

describe("routeConsoleInput", () => {
  test("ignores empty lines and comments", () => {
    expect(routeConsoleInput("")).toEqual({ kind: "skip" });
    expect(routeConsoleInput("   ")).toEqual({ kind: "skip" });
    expect(routeConsoleInput("# a comment")).toEqual({ kind: "skip" });
    expect(routeConsoleInput("  # indented comment")).toEqual({ kind: "skip" });
  });

  test("recognizes exit and quit case-insensitively", () => {
    expect(routeConsoleInput("exit")).toEqual({ kind: "exit" });
    expect(routeConsoleInput("quit")).toEqual({ kind: "exit" });
    expect(routeConsoleInput("  EXIT  ")).toEqual({ kind: "exit" });
    expect(routeConsoleInput("QuIt")).toEqual({ kind: "exit" });
  });

  test("routes everything else as a command line", () => {
    expect(routeConsoleInput("balance")).toEqual({ kind: "command", text: "balance" });
    expect(routeConsoleInput('send "addr" "1.0"')).toEqual({ kind: "command", text: 'send "addr" "1.0"' });
  });
});

describe("ConsoleSession", () => {
  test("executes commands through the registry and writes the output", async () => {
    const registry = stubRegistry();
    const lines: string[] = [];
    const session = new ConsoleSession(registry, ctxStub(), { write: (line) => lines.push(line) });
    const ended = await session.feed("echo hello world");
    expect(ended).toBe(false);
    expect(lines).toEqual(["hello world"]);
    expect(session.running).toBe(true);
  });

  test("skips blanks and ends on exit", async () => {
    const registry = stubRegistry();
    const lines: string[] = [];
    let exited = false;
    const session = new ConsoleSession(registry, ctxStub(), {
      write: (line) => lines.push(line),
      onExit: () => {
        exited = true;
      },
    });
    await session.feed("");
    await session.feed("# note");
    expect(lines).toEqual([]);
    const ended = await session.feed("exit");
    expect(ended).toBe(true);
    expect(exited).toBe(true);
    expect(session.running).toBe(false);
  });

  test("sensitive commands use the interactive askSecret bridge", async () => {
    const registry = stubRegistry();
    const lines: string[] = [];
    let prompts = 0;
    const session = new ConsoleSession(
      registry,
      {
        core: coreStub(true),
        log: silentLog,
        interactive: true,
        askSecret: async () => {
          prompts += 1;
          return "right";
        },
      },
      { write: (line) => lines.push(line) },
    );
    await session.feed("wallet");
    expect(prompts).toBe(1);
    expect(lines).toEqual(["ok"]);
  });

  test("propagates execution errors as Error lines", async () => {
    const registry = stubRegistry({
      boom: () => {
        throw new Error("kaboom");
      },
    });
    const lines: string[] = [];
    const session = new ConsoleSession(registry, ctxStub(), { write: (line) => lines.push(line) });
    await session.feed("boom");
    expect(lines).toEqual(["Error: kaboom"]);
  });
});
