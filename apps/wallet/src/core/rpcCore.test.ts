import { describe, expect, test } from "bun:test";
import { GENESIS_BLOCK } from "@edgex/core";
import type { Block } from "@edgex/core";
import type { ConnectionManager } from "./connection";
import { decodeBlockHex, submitBlock } from "./rpcCore";

/** Serialize a block to the wire representation: difficulty travels as a string. */
function wireBlock(block: Block): string {
  const json = JSON.parse(JSON.stringify(block, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  return hexOf(json);
}

function hexOf(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}

function sampleBlock(): Block {
  return {
    header: {
      version: 1,
      height: 1,
      previousHash: GENESIS_BLOCK.hash,
      timestampSeconds: GENESIS_BLOCK.header.timestampSeconds + 15,
      difficulty: GENESIS_BLOCK.header.difficulty,
      merkleRoot: "0".repeat(64),
      powSeed: GENESIS_BLOCK.hash,
      payoutAddress: "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f",
    },
    hash: "a".repeat(64),
    nonce: 7,
    coinbase: { outputs: [{ address: "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f", amount: "400.00000000" }] },
    transactions: [],
  };
}

describe("submitblock payload decoding", () => {
  test("decodes a valid hex(UTF-8 JSON) block body", () => {
    const block = sampleBlock();
    const decoded = decodeBlockHex(wireBlock(block));
    expect(decoded).not.toBeNull();
    expect(decoded!.header.height).toBe(1);
    expect(decoded!.header.difficulty).toBe(block.header.difficulty);
    expect(decoded!.header.previousHash).toBe(GENESIS_BLOCK.hash);
    expect(decoded!.nonce).toBe(7);
    expect(decoded!.coinbase?.outputs[0]?.amount).toBe("400.00000000");
    expect(decoded!.transactions).toHaveLength(0);
  });

  test("accepts a string difficulty field (JSON bigint convention)", () => {
    const block = sampleBlock();
    const decoded = decodeBlockHex(wireBlock(block));
    expect(decoded!.header.difficulty).toBe(block.header.difficulty);
  });

  test("rejects non-hex, non-JSON and structurally invalid payloads", () => {
    expect(decodeBlockHex("not hex!!")).toBeNull();
    expect(decodeBlockHex("")).toBeNull();
    expect(decodeBlockHex(Buffer.from("not json", "utf8").toString("hex"))).toBeNull();
    expect(decodeBlockHex(hexOf({ hello: "world" }))).toBeNull();
    const noHeader = { ...sampleBlock() } as Record<string, unknown>;
    delete noHeader.header;
    expect(decodeBlockHex(wireBlock(noHeader as unknown as Block))).toBeNull();
    const badHash = { ...sampleBlock(), hash: "zz" };
    expect(decodeBlockHex(wireBlock(badHash))).toBeNull();
    const zeroDiff = JSON.parse(JSON.stringify(sampleBlock(), (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
    zeroDiff.header.difficulty = 0;
    expect(decodeBlockHex(hexOf(zeroDiff))).toBeNull();
  });
});

describe("submitblock node status mapping", () => {
  function connWith(request: (method: string, path: string, body?: unknown) => Promise<unknown>): ConnectionManager {
    return { request: request as ConnectionManager["request"] } as unknown as ConnectionManager;
  }

  test("maps an extended node result to success (null status)", async () => {
    const conn = connWith(async () => ({ result: "extended" }));
    const result = await submitBlock(conn, sampleBlock());
    expect(result.status).toBeNull();
    expect(result.rejectReason).toBeUndefined();
  });

  test("maps a known node result to duplicate", async () => {
    const conn = connWith(async () => ({ result: "known" }));
    const result = await submitBlock(conn, sampleBlock());
    expect(result.status).toBe("duplicate");
  });

  test("maps a fork node result to inconclusive", async () => {
    const conn = connWith(async () => ({ result: "fork" }));
    const result = await submitBlock(conn, sampleBlock());
    expect(result.status).toBe("inconclusive");
  });

  test("maps a node rejection to rejected with the reason", async () => {
    const conn = connWith(async () => {
      throw new Error("merkle root mismatch");
    });
    const result = await submitBlock(conn, sampleBlock());
    expect(result.status).toBe("rejected");
    expect(result.rejectReason).toContain("merkle root mismatch");
  });

  test("maps an unexpected node result to rejected", async () => {
    const conn = connWith(async () => ({ result: "something-else" }));
    const result = await submitBlock(conn, sampleBlock());
    expect(result.status).toBe("rejected");
  });
});
