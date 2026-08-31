import type { WalletCore } from "../core/walletCore";
import { WalletError } from "../core/errors";
import type { Logger } from "../utils/log";
import { t } from "../i18n";

export interface CommandContext {
  core: WalletCore;
  log: Logger;
  registry?: CommandRegistry;

  interactive?: boolean;

  password?: string;

  ask?: AskFn;

  datadir?: string;
}


export interface AskOption {
  value: string;
  label: string;
}


export interface AskQuestion {
  type: "choice" | "text" | "password";
  prompt: string;

  options?: AskOption[];

  default?: string;

  lines?: string[];
}


export type AskFn = (question: AskQuestion) => Promise<string>;

export interface Command {
  name: string;
  aliases?: string[];

  summary: string | (() => string);

  usage: string | (() => string);
  run: (args: string[], ctx: CommandContext) => Promise<string> | string;
}


export function splitWords(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * Command registry shared by the TUI bottom command line and one-shot CLI.
 * RPC methods call WalletCore directly (consistent with command semantics).
 */
export class CommandRegistry {
  private map = new Map<string, Command>();
  private commands: Command[] = [];

  register(cmd: Command): void {
    this.commands.push(cmd);
    for (const name of [cmd.name, ...(cmd.aliases ?? [])]) {
      this.map.set(name, cmd);
    }
  }

  registerAll(cmds: Command[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  get(name: string): Command | undefined {
    return this.map.get(name);
  }

  list(): Command[] {
    return this.commands;
  }

  helpText(): string {
    const lines = [t("cmd.helpTitle")];
    for (const cmd of this.commands) {
      const summary = typeof cmd.summary === "function" ? cmd.summary() : cmd.summary;
      const aliases = cmd.aliases?.length ? t("cmd.helpAliases", { aliases: cmd.aliases.join(", ") }) : "";
      const usage = typeof cmd.usage === "function" ? cmd.usage() : cmd.usage;
      lines.push(`  ${usage.padEnd(38)} ${summary}${aliases}`);
    }
    return lines.join("\n");
  }

  async execute(line: string, ctx: CommandContext): Promise<string> {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const parts = splitWords(trimmed);
    const cmd = this.get(parts[0]);
    if (!cmd) return `Unknown command: ${parts[0]} (type help for usage)`;
    try {
      return await cmd.run(parts.slice(1), { ...ctx, registry: this });
    } catch (e) {
      if (e instanceof WalletError) return `Error (${e.code}): ${e.message}`;
      return `Error: ${(e as Error).message}`;
    }
  }
}