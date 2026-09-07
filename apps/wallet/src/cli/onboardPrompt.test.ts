import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLang, t } from "../i18n";
import { OnboardCancelledError, parseOnboardChoice, runCliOnboarding, type OnboardHooks } from "./onboardPrompt";
import { hasVault, readVaultFile, vaultFilePath } from "../keys/vaultLegacy";
import { decryptMnemonic } from "../keys/vaultLegacy";
import { isValidMnemonic } from "../keys/mnemonic";

function makeHooks(answers: { lines?: string[]; secrets?: string[]; tty?: boolean } = {}): {
  hooks: OnboardHooks;
  output: string[];
  lineCount: () => number;
} {
  const output: string[] = [];
  const lines = [...(answers.lines ?? [])];
  const secrets = [...(answers.secrets ?? [])];
  const hooks: OnboardHooks = {
    isTty: () => answers.tty ?? true,
    out: (line) => output.push(line),
    line: async () => lines.shift() ?? "",
    secret: async () => secrets.shift() ?? "",
  };
  return { hooks, output, lineCount: () => lines.length };
}

// The onboarding copy goes through the i18n layer; pin the default locale so
// the output assertions below are deterministic regardless of test order.
setLang("zh");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "edgex-onboard-"));
}

describe("parseOnboardChoice", () => {
  test("maps create, import, cancel and invalid input", () => {
    expect(parseOnboardChoice("1")).toBe("create");
    expect(parseOnboardChoice(" 2 ")).toBe("import");
    expect(parseOnboardChoice("")).toBe("cancel");
    expect(parseOnboardChoice("  ")).toBe("cancel");
    expect(parseOnboardChoice("3")).toBe("invalid");
    expect(parseOnboardChoice("x")).toBe("invalid");
  });
});

describe("runCliOnboarding", () => {
  test("returns null on a non-interactive terminal", async () => {
    const dir = tempDir();
    try {
      const { hooks } = makeHooks({ tty: false });
      expect(await runCliOnboarding({ datadir: dir, hooks })).toBeNull();
      expect(hasVault(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws OnboardCancelledError when the mode choice is empty", async () => {
    const dir = tempDir();
    try {
      const { hooks } = makeHooks({ lines: [""] });
      await expect(runCliOnboarding({ datadir: dir, hooks })).rejects.toBeInstanceOf(OnboardCancelledError);
      expect(hasVault(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-prompts on an invalid choice, then cancels", async () => {
    const dir = tempDir();
    try {
      const { hooks, output } = makeHooks({ lines: ["9", ""] });
      await expect(runCliOnboarding({ datadir: dir, hooks })).rejects.toBeInstanceOf(OnboardCancelledError);
      expect(output.some((line) => line.includes(t("ob.invalidChoice")))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a wallet, writes a vault and shows the mnemonic once", async () => {
    const dir = tempDir();
    try {
      const password = "correct horse battery";
      const { hooks, output } = makeHooks({ lines: ["1", ""], secrets: [password, password] });
      const result = await runCliOnboarding({ datadir: dir, hooks });
      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.password).toBe(password);
      expect(isValidMnemonic(result!.key.mnemonic)).toBe(true);
      expect(hasVault(dir)).toBe(true);
      // The vault decrypts with the chosen password and holds the same mnemonic.
      const stored = decryptMnemonic(readVaultFile(dir), password);
      expect(stored).toBe(result!.key.mnemonic);
      // Backup text and the mnemonic itself are printed for offline backup.
      const text = output.join("\n");
      expect(text).toContain(result!.key.mnemonic);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a short password and mismatched confirmation until both pass", async () => {
    const dir = tempDir();
    try {
      const { hooks, output } = makeHooks({
        lines: ["1", ""],
        secrets: ["ab", "pass1234", "different", "pass1234", "pass1234"],
      });
      const result = await runCliOnboarding({ datadir: dir, hooks });
      expect(result).not.toBeNull();
      expect(result!.password).toBe("pass1234");
      const text = output.join("\n");
      expect(text).toContain("at least 4 characters");
      expect(text).toContain("do not match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores a wallet from a valid mnemonic and rejects a broken one", async () => {
    const dir = tempDir();
    try {
      const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      const password = "restore-pass";
      const { hooks, output } = makeHooks({
        lines: ["2", "not a real mnemonic", mnemonic],
        secrets: [password, password],
      });
      const result = await runCliOnboarding({ datadir: dir, hooks });
      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.key.mnemonic).toBe(mnemonic);
      expect(hasVault(dir)).toBe(true);
      const text = output.join("\n");
      expect(text).toContain("Invalid BIP39 mnemonic");
      expect(text).toContain("Wallet restored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
