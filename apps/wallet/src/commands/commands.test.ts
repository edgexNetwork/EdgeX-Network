import { describe, expect, test } from "bun:test";
import { PASSWORD_RETRY_LIMIT, withPasswordConfirm } from "./commands";
import type { CommandContext } from "./registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walletError, RPC_CODE } from "../core/errors";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as CommandContext["log"];

function ctxWithSecret(answers: string[]): { ctx: CommandContext; promptCount: () => number } {
  let prompts = 0;
  const ctx: CommandContext = {
    core: { requirePassword: () => true } as unknown as CommandContext["core"],
    log: silentLog,
    interactive: true,
    askSecret: async () => {
      prompts += 1;
      return answers[prompts - 1] ?? "";
    },
    datadir: mkdtempSync(join(tmpdir(), "edgex-cmd-")),
  };
  return { ctx, promptCount: () => prompts };
}

function noVaultCtx(): CommandContext {
  return {
    core: { requirePassword: () => false } as unknown as CommandContext["core"],
    log: silentLog,
    interactive: false,
    datadir: mkdtempSync(join(tmpdir(), "edgex-cmd-")),
  };
}

describe("withPasswordConfirm", () => {
  test("skips verification entirely when the wallet has no vault", async () => {
    const calls: string[] = [];
    const result = await withPasswordConfirm(noVaultCtx(), (password) => {
      calls.push(password);
      return `ran-${password}`;
    }, "op");
    expect(calls).toEqual([""]);
    expect(result).toBe("ran-");
  });

  test("verifies on the first correct password", async () => {
    const { ctx } = ctxWithSecret(["secret"]);
    const result = await withPasswordConfirm(ctx, (password) => `ok:${password}`, "op");
    expect(result).toBe("ok:secret");
  });

  test("retries up to the limit on wrong passwords, then propagates", async () => {
    const answers = ["bad1", "bad2", "bad3", "bad4"];
    const { ctx, promptCount } = ctxWithSecret(answers);
    await expect(
      withPasswordConfirm(ctx, () => {
        throw walletError(RPC_CODE.GENERIC, "Wrong wallet password");
      }, "op"),
    ).rejects.toMatchObject({ message: "Wrong wallet password" });
    expect(promptCount()).toBe(PASSWORD_RETRY_LIMIT);
  });

  test("succeeds when a later attempt is correct", async () => {
    const answers = ["wrong", "right"];
    const { ctx, promptCount } = ctxWithSecret(answers);
    let calls = 0;
    const result = await withPasswordConfirm(ctx, (password) => {
      calls += 1;
      if (password !== "right") throw walletError(RPC_CODE.GENERIC, "Wrong wallet password");
      return `ok:${password}`;
    }, "op");
    expect(promptCount()).toBe(2);
    expect(result).toBe("ok:right");
  });

  test("cancels on an empty password", async () => {
    const { ctx, promptCount } = ctxWithSecret([""]);
    const result = await withPasswordConfirm(ctx, () => "unreachable", "op");
    expect(result).toBeNull();
    expect(promptCount()).toBe(1);
  });

  test("propagates non-password errors immediately without retrying", async () => {
    const { ctx, promptCount } = ctxWithSecret(["pw"]);
    await expect(
      withPasswordConfirm(ctx, () => {
        throw walletError(RPC_CODE.INVALID_ADDRESS_OR_KEY, "Address is not in this wallet");
      }, "op"),
    ).rejects.toMatchObject({ code: RPC_CODE.INVALID_ADDRESS_OR_KEY });
    expect(promptCount()).toBe(1);
  });

  test("refuses to run without an interactive secret source", async () => {
    const ctx: CommandContext = {
      core: { requirePassword: () => true } as unknown as CommandContext["core"],
      log: silentLog,
      interactive: false,
      datadir: mkdtempSync(join(tmpdir(), "edgex-cmd-")),
    };
    await expect(withPasswordConfirm(ctx, () => "never", "op")).rejects.toThrow(/requires interactive wallet-password confirmation/);
  });
});
