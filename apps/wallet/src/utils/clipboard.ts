import { spawn } from "node:child_process";







export function clipboardCommands(platform: NodeJS.Platform = process.platform): string[][] {
  switch (platform) {
    case "win32":
      return [["clip"]];
    case "darwin":
      return [["pbcopy"]];
    case "linux":
      return [
        ["xclip", "-selection", "clipboard"],
        ["wl-copy"],
        ["xsel", "--clipboard", "--input"],
      ];
    default:
      return [];
  }
}


function runClipboardWriter(argv: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "pipe"] }) as any;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += String(d);
    });
    child.stdin.on("error", () => {

    });
    child.on("error", (e: Error) => reject(e));
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Clipboard command exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}


export async function writeClipboard(text: string, commands: string[][]): Promise<boolean> {
  for (const argv of commands) {
    try {
      await runClipboardWriter(argv, text);
      return true;
    } catch {

    }
  }
  return false;
}


export function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return writeClipboard(text, clipboardCommands(platform));
}
