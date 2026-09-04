import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bytesToHex, validateAddress, verifySignature } from "@edgex/shared";
import {
  addressesFilePath,
  deriveChangeAddress,
  deriveExternalAddress,
  findAddressIndex,
  HD_CHANGE_EXTERNAL,
  HD_CHANGE_INTERNAL,
  listWalletAddresses,
  nextChangeAddress,
  nextExternalAddress,
  privateKeyHexForAddress,
  signForAddress,
} from "../src/keys/addressIndex";

/** A fixed 12-word mnemonic so derivation is deterministic and reproducible. */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/** Golden address for this mnemonic at the main external index 0. */
const GOLDEN_MAIN = "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f";

const root = mkdtempSync(join(tmpdir(), "edgex-address-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh, empty wallet directory for one test (never shared). */
let counter = 0;
function freshDir(): string {
  counter += 1;
  return join(root, `wallet-${counter}`);
}

describe("HD address derivation", () => {
  test("external index 0 is the golden main address", () => {
    const derived = deriveExternalAddress(TEST_MNEMONIC, 0);
    expect(derived.address).toBe(GOLDEN_MAIN);
    expect(validateAddress(derived.address)).toBe(true);
  });

  test("external and change branches derive distinct, valid addresses", () => {
    const external1 = deriveExternalAddress(TEST_MNEMONIC, 1);
    const change0 = deriveChangeAddress(TEST_MNEMONIC, 0);
    expect(validateAddress(external1.address)).toBe(true);
    expect(validateAddress(change0.address)).toBe(true);
    expect(external1.address).not.toBe(GOLDEN_MAIN);
    expect(change0.address).not.toBe(GOLDEN_MAIN);
    expect(external1.address).not.toBe(change0.address);
    expect(external1.publicKey.length).toBe(33);
    expect(change0.publicKey.length).toBe(33);
  });

  test("rejects an invalid branch or index", () => {
    expect(() => deriveExternalAddress(TEST_MNEMONIC, -1)).toThrow(RangeError);
    expect(() => deriveExternalAddress(TEST_MNEMONIC, 1.5)).toThrow(RangeError);
  });
});

describe("address index file and counters", () => {
  test("defaults to the main external address plus the first change address", () => {
    // The default index file pre-derives external index 0 (main) and change
    // index 0, so a fresh wallet owns exactly those two addresses.
    expect(listWalletAddresses(freshDir(), TEST_MNEMONIC)).toEqual([
      deriveExternalAddress(TEST_MNEMONIC, 0).address,
      deriveChangeAddress(TEST_MNEMONIC, 0).address,
    ]);
  });

  test("nextExternalAddress derives and persists the next index", () => {
    const dir = freshDir();
    const first = nextExternalAddress(dir, TEST_MNEMONIC);
    expect(first.index).toBe(1);
    const second = nextExternalAddress(dir, TEST_MNEMONIC);
    expect(second.index).toBe(2);
    const state = JSON.parse(readFileSync(addressesFilePath(dir), "utf8")) as {
      nextExternalIndex: number;
      nextChangeIndex: number;
    };
    expect(state.nextExternalIndex).toBe(3);
    expect(state.nextChangeIndex).toBe(1);
  });

  test("listWalletAddresses returns external addresses first, then change", () => {
    const dir = freshDir();
    nextExternalAddress(dir, TEST_MNEMONIC);
    nextExternalAddress(dir, TEST_MNEMONIC);
    nextChangeAddress(dir, TEST_MNEMONIC);
    // Defaults pre-derived external 0 + change 0; the calls add external 1..2
    // and change 1. External addresses always precede change addresses.
    const list = listWalletAddresses(dir, TEST_MNEMONIC);
    expect(list).toEqual([
      deriveExternalAddress(TEST_MNEMONIC, 0).address,
      deriveExternalAddress(TEST_MNEMONIC, 1).address,
      deriveExternalAddress(TEST_MNEMONIC, 2).address,
      deriveChangeAddress(TEST_MNEMONIC, 0).address,
      deriveChangeAddress(TEST_MNEMONIC, 1).address,
    ]);
  });

  test("findAddressIndex resolves derived addresses and rejects foreign ones", () => {
    const dir = freshDir();
    nextExternalAddress(dir, TEST_MNEMONIC);
    nextExternalAddress(dir, TEST_MNEMONIC);
    nextChangeAddress(dir, TEST_MNEMONIC);
    expect(findAddressIndex(dir, TEST_MNEMONIC, GOLDEN_MAIN)).toEqual({ change: HD_CHANGE_EXTERNAL, index: 0 });
    expect(findAddressIndex(dir, TEST_MNEMONIC, deriveExternalAddress(TEST_MNEMONIC, 1).address)).toEqual({
      change: HD_CHANGE_EXTERNAL,
      index: 1,
    });
    expect(findAddressIndex(dir, TEST_MNEMONIC, deriveChangeAddress(TEST_MNEMONIC, 0).address)).toEqual({
      change: HD_CHANGE_INTERNAL,
      index: 0,
    });
    // Index 3 external was never derived: not a wallet address.
    expect(findAddressIndex(dir, TEST_MNEMONIC, deriveExternalAddress(TEST_MNEMONIC, 3).address)).toBeNull();
    expect(findAddressIndex(dir, TEST_MNEMONIC, "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt70")).toBeNull();
  });
});

describe("per-address keys and signing", () => {
  test("privateKeyHexForAddress returns the key of the derived address", () => {
    const dir = freshDir();
    nextExternalAddress(dir, TEST_MNEMONIC); // derives external index 1
    const derived = deriveExternalAddress(TEST_MNEMONIC, 1);
    const hex = privateKeyHexForAddress(dir, TEST_MNEMONIC, derived.address);
    expect(hex).toBe(bytesToHex(derived.privateKey));
    expect(() => privateKeyHexForAddress(dir, TEST_MNEMONIC, "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt70")).toThrow(
      /not in this wallet/,
    );
  });

  test("signForAddress signs with the address key and verifies against its public key", () => {
    const dir = freshDir();
    nextChangeAddress(dir, TEST_MNEMONIC); // derives change index 1
    const derived = deriveChangeAddress(TEST_MNEMONIC, 1);
    const signature = signForAddress(dir, TEST_MNEMONIC, derived.address, "hello");
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifySignature(bytesToHex(derived.publicKey), "hello", signature)).toBe(true);
  });
});
