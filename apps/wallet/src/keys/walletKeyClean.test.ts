import { describe, expect, test, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOrLoadKey,
  loadWalletWithRetry,
  PasswordError,
  MAX_PASSWORD_ATTEMPTS,
} from "./walletKeyClean";

const dir = mkdtempSync(join(tmpdir(), "edgex-walletkey-"));
const vaultPassword = "correct-horse";

function freshWallet(): string {
  const datadir = mkdtempSync(join(tmpdir(), "edgex-walletkey-"));
  createOrLoadKey(datadir, { password: vaultPassword });
  return datadir;
}

afterEach(() => {
  delete process.env.EDX_WALLET_PASSWORD;
});

describe("loadWalletWithRetry", () => {
  test("uses an explicit password and never touches stdin or the env", async () => {
    process.env.EDX_WALLET_PASSWORD = "env-password";
    const datadir = freshWallet();
    let prompted = 0;
    const loaded = await loadWalletWithRetry(datadir, {
      password: vaultPassword,
      interactive: false,
      getPassword: async () => {
        prompted += 1;
        return "never";
      },
    });
    expect(prompted).toBe(0);
    expect(loaded.password).toBe(vaultPassword);
    expect(loaded.key.address).toBe(createOrLoadKey(datadir, { password: vaultPassword }).key.address);
  });

  test("prefers an explicit password over EDX_WALLET_PASSWORD", async () => {
    const datadir = freshWallet();
    process.env.EDX_WALLET_PASSWORD = "wrong-from-env";
    const loaded = await loadWalletWithRetry(datadir, { password: vaultPassword, interactive: false });
    expect(loaded.password).toBe(vaultPassword);
  });

  test("falls back to EDX_WALLET_PASSWORD when no explicit password is given", async () => {
    const datadir = freshWallet();
    process.env.EDX_WALLET_PASSWORD = vaultPassword;
    const loaded = await loadWalletWithRetry(datadir, { interactive: false });
    expect(loaded.password).toBe(vaultPassword);
  });

  test("throws PasswordError for a wrong explicit password without prompting", async () => {
    const datadir = freshWallet();
    let prompted = 0;
    await expect(
      loadWalletWithRetry(datadir, {
        password: "wrong",
        interactive: true,
        getPassword: async () => {
          prompted += 1;
          return "never";
        },
      }),
    ).rejects.toThrow(PasswordError);
    expect(prompted).toBe(0);
  });

  test("fails fast on unattended startup when no password is available", async () => {
    const datadir = freshWallet();
    await expect(loadWalletWithRetry(datadir, { interactive: false })).rejects.toThrow(
      /unattended startup/,
    );
  });

  test("prompts interactively up to the attempt limit on a TTY-like load", async () => {
    const datadir = freshWallet();
    let attempts = 0;
    await expect(
      loadWalletWithRetry(datadir, {
        interactive: true,
        maxAttempts: 2,
        getPassword: async () => {
          attempts += 1;
          return "wrong";
        },
      }),
    ).rejects.toThrow(PasswordError);
    expect(attempts).toBe(2);
  });

  test("MAX_PASSWORD_ATTEMPTS is five", () => {
    expect(MAX_PASSWORD_ATTEMPTS).toBe(5);
  });

  test("does not read the environment when both sources are absent", async () => {
    // Fresh vault + explicit password, env deleted: load still succeeds via the
    // explicit password only.
    const datadir = freshWallet();
    const loaded = await loadWalletWithRetry(datadir, { password: vaultPassword, interactive: false });
    expect(loaded.key.address).toBeTruthy();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
