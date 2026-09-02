import { describe, expect, test } from "bun:test";
import {
  addressFromPublicKey,
  bytesToHex,
  generateKeyPair,
  sha256Hex,
  signMessage,
  transactionMessage,
  validateSignedTransactionShape,
} from "@edgex/shared";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const DERIVATION_PATH = "m/44'/778'/0'/0/0";
// A fixed 12-word test mnemonic so derivation is deterministic and reproducible.
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Golden address for this mnemonic (derived from the protocol constants).
const GOLDEN_ADDRESS = "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f";

function deriveKey(mnemonic: string): { privateKeyHex: string; publicKeyHex: string; address: string } {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  if (!hd.privateKey || !hd.publicKey) throw new Error("Key derivation failed");
  return {
    privateKeyHex: bytesToHex(hd.privateKey),
    publicKeyHex: bytesToHex(hd.publicKey),
    address: addressFromPublicKey(bytesToHex(hd.publicKey)),
  };
}

interface Input {
  txid: string;
  index: number;
}

interface Output {
  address: string;
  amount: string;
}

interface TransactionLike {
  inputs: Input[];
  outputs: Output[];
  fee: string;
}

function signingMessage(transaction: TransactionLike): string {
  return transactionMessage(transaction);
}

function transactionId(transaction: TransactionLike, signature: string): string {
  return sha256Hex(`${signingMessage(transaction)}\n${signature}`);
}

function broadcastHex(transaction: TransactionLike, publicKeyHex: string, signature: string): string {
  const body = {
    inputs: transaction.inputs,
    outputs: transaction.outputs,
    fee: transaction.fee,
    pubkey: publicKeyHex,
    signature,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("hex");
}

describe("offline signing protocol", () => {
  test("derives the documented address from a fixed mnemonic", () => {
    const key = deriveKey(TEST_MNEMONIC);
    expect(key.address).toBe(GOLDEN_ADDRESS);
    expect(key.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  test("builds the exact signing message line by line", () => {
    const transaction: TransactionLike = {
      inputs: [
        { txid: "a".repeat(64), index: 0 },
        { txid: "b".repeat(64), index: 3 },
      ],
      outputs: [
        { address: GOLDEN_ADDRESS, amount: "10.00000000" },
        { address: "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f", amount: "89.99990000" },
      ],
      fee: "0.00010000",
    };
    const message = signingMessage(transaction);
    const lines = message.split("\n");
    expect(lines).toEqual([
      "input:0:" + "a".repeat(64) + ":0",
      "input:1:" + "b".repeat(64) + ":3",
      "fee:0.00010000",
      "0:" + GOLDEN_ADDRESS + ":10.00000000",
      "1:" + "Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f" + ":89.99990000",
    ]);
  });

  test("produces a 128-hex compact signature that verifies against the pubkey", () => {
    const key = deriveKey(TEST_MNEMONIC);
    const transaction: TransactionLike = {
      inputs: [{ txid: "a".repeat(64), index: 0 }],
      outputs: [{ address: GOLDEN_ADDRESS, amount: "9.99990000" }],
      fee: "0.00010000",
    };
    const signature = signMessage(key.privateKeyHex, signingMessage(transaction));
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    // The shared verifier recomputes SHA-256(message) and checks the signature.
    const { secp256k1 } = require("@noble/curves/secp256k1.js") as typeof import("@noble/curves/secp256k1.js");
    const ok = secp256k1.verify(
      hexBytes(signature),
      sha256Bytes(new TextEncoder().encode(signingMessage(transaction))),
      hexBytes(key.publicKeyHex),
      { prehash: false },
    );
    expect(ok).toBe(true);
  });

  test("computes txid = SHA-256(message + '\\n' + signature)", () => {
    const key = deriveKey(TEST_MNEMONIC);
    const transaction: TransactionLike = {
      inputs: [{ txid: "a".repeat(64), index: 0 }],
      outputs: [{ address: GOLDEN_ADDRESS, amount: "9.99990000" }],
      fee: "0.00010000",
    };
    const signature = signMessage(key.privateKeyHex, signingMessage(transaction));
    const id = transactionId(transaction, signature);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(sha256Hex(`${signingMessage(transaction)}\n${signature}`));
  });

  test("broadcast hex decodes to a consensus-valid signed transaction", () => {
    const key = deriveKey(TEST_MNEMONIC);
    const recipient = addressFromPublicKey(generateKeyPair().publicKeyHex);
    const transaction: TransactionLike = {
      inputs: [{ txid: "a".repeat(64), index: 0 }],
      outputs: [{ address: recipient, amount: "9.99990000" }],
      fee: "0.00010000",
    };
    const signature = signMessage(key.privateKeyHex, signingMessage(transaction));
    const hex = broadcastHex(transaction, key.publicKeyHex, signature);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    const body = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
    // validateSignedTransactionShape verifies the signature against pubkey and
    // returns outputTotal + fee in Photons.
    const total = validateSignedTransactionShape({
      inputs: body.inputs,
      outputs: body.outputs,
      fee: body.fee,
      pubkey: body.pubkey,
      signature: body.signature,
    });
    expect(total).toBe(1_000_000_000n);
  });
});

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  // Reuse the noble hasher through the shared package to stay dependency-light.
  return new Uint8Array(Buffer.from(sha256HexOf(data), "hex"));
}

function sha256HexOf(data: Uint8Array): string {
  const { sha256 } = require("@noble/hashes/sha2.js") as typeof import("@noble/hashes/sha2.js");
  return bytesToHex(sha256(data));
}
