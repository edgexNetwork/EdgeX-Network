import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  EDX_UNIT,
  addressFromPublicKey,
  formatEdxAmount,
  generateKeyPair,
} from "@edgex/shared";
import { GENESIS_BLOCK } from "@edgex/core";
import { initGlobalData, readGlobalData, writeGlobalData } from "../src/core/globalData";
import { ChainStore, decryptChainDb, deriveChainDbKey } from "../src/core/walletDatabase";

const root = mkdtempSync(join(tmpdir(), "edgex-storage-"));

function newStore(name: string, privateKey: Uint8Array): ChainStore {
  const filePath = isAbsolute(name) ? name : join(root, name);
  return new ChainStore(filePath, deriveChainDbKey(privateKey), "EDXTARGET");
}

function minedBlock(height: number, previousHash: string, address: string) {
  return {
    header: {
      version: 1,
      height,
      previousHash,
      timestampSeconds: GENESIS_BLOCK.header.timestampSeconds + height * 15,
      difficulty: GENESIS_BLOCK.header.difficulty,
      merkleRoot: "0".repeat(64),
      powSeed: GENESIS_BLOCK.header.powSeed,
      payoutAddress: address,
    },
    hash: (height.toString(16).padStart(4, "0") + "f").padEnd(64, "0"),
    nonce: height,
    coinbase: { outputs: [{ address, amount: formatEdxAmount(400n * EDX_UNIT) }] },
    transactions: [],
  };
}

describe("encrypted wallet chain database", () => {
  const owner = generateKeyPair();
  const ownerPrivateKey = Buffer.from(owner.privateKeyHex, "hex");
  const address = addressFromPublicKey(owner.publicKeyHex);
  const databasePath = join(root, "wallet.chain.db");
  const store = newStore(databasePath, ownerPrivateKey);

  test("creates, indexes, encrypts, saves, and reopens the wallet database", () => {
    expect(store.open()).toEqual({ ok: true, existed: false });
    expect(store.localHeight()).toBe(-1);
    expect(store.appendBlocks([GENESIS_BLOCK, minedBlock(1, GENESIS_BLOCK.hash, address)])).toBe(2);
    store.save();
    store.close();

    const reopened = newStore(databasePath, ownerPrivateKey);
    expect(reopened.open()).toEqual({ ok: true, existed: true });
    expect(reopened.localTip().height).toBe(1);
    expect(reopened.addressBalance(address)).toBe(400n * EDX_UNIT);
    expect(reopened.addressUtxos(address, 7)).toHaveLength(1);
    reopened.close();
  });

  test("binds the encrypted database to the owning wallet private key", () => {
    const foreignPath = join(root, "foreign.db");
    const foreign = newStore(foreignPath, Buffer.from(generateKeyPair().privateKeyHex, "hex"));
    copyFileSync(databasePath, foreignPath);
    const opened = foreign.open();
    expect(opened.ok).toBe(false);
    expect(opened.error).toMatch(/belongs to another wallet|decryption failed/i);
  });

  test("keeps the on-disk payload opaque", () => {
    const raw = readFileSync(databasePath);
    expect(raw.subarray(0, 7).toString("ascii")).toBe("EDXCHDB");
    expect(raw.includes(Buffer.from(formatEdxAmount(400n * EDX_UNIT)))).toBe(false);
    const key = deriveChainDbKey(ownerPrivateKey);
    const decrypted = decryptChainDb(raw, key);
    expect(decrypted.length).toBeGreaterThan(0);
  });
});

describe("machine-wide global data", () => {
  const directory = mkdtempSync(join(tmpdir(), "edgex-global-"));
  test("creates an encrypted database and persists safe preferences", () => {
    const created = initGlobalData(directory);
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);
    writeGlobalData("test.value", "kept");
    expect(readGlobalData("test.value")).toBe("kept");
    expect(initGlobalData(directory).created).toBe(false);
    expect(readGlobalData("test.value")).toBe("kept");
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
