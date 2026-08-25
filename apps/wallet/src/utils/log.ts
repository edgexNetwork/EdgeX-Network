export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
}

export interface LoggerOptions {
  console?: boolean;
  file?: string;
}




export class Logger {
  private sinks = new Set<(line: LogLine) => void>();
  private history: LogLine[] = [];
  private historyLimit: number;
  private fileSink: ((line: LogLine) => void) | null = null;

  constructor(private opts: LoggerOptions = {}, historyLimit = 500) {
    this.historyLimit = historyLimit;
    if (opts.file) {
      const fs = require("node:fs") as typeof import("node:fs");
      this.fileSink = (line) => {
        const ts = new Date(line.ts).toISOString();
        fs.appendFileSync(opts.file!, `[${ts}] [${line.level}] ${line.message}\n`);
      };
    }
  }

  onSink(cb: (line: LogLine) => void): () => void {
    this.sinks.add(cb);
    return () => this.sinks.delete(cb);
  }

  recent(n: number): LogLine[] {
    return this.history.slice(-n);
  }

  private write(level: LogLevel, message: string) {
    const line: LogLine = { ts: Date.now(), level, message };
    this.history.push(line);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    if (this.opts.console) {
      const label = level === "error" ? "ERR " : level === "warn" ? "WARN" : level === "debug" ? "DBG " : "INFO";
      const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      method(`[${new Date(line.ts).toLocaleTimeString("zh-CN", { hour12: false })}] [${label}] ${message}`);
    }
    this.fileSink?.(line);
    for (const cb of this.sinks) {
      try {
        cb(line);
      } catch {

      }
    }
  }

  info(message: string) { this.write("info", message); }
  warn(message: string) { this.write("warn", message); }
  error(message: string) { this.write("error", message); }
  debug(message: string) { this.write("debug", message); }
}