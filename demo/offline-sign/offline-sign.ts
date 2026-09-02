#!/usr/bin/env bun
/**
 * Offline transaction signing demo.
 *
 * Everything private happens here, away from any wallet or node:
 *   1. Generate (or accept) a BIP39 mnemonic and derive the EDX address.
 *   2. Build the transaction signing message from inputs/outputs/fee.
 *   3. Hash it once with SHA-256 and sign with secp256k1 (compact r||s).
 *   4. Compute the transaction id and print the broadcastable hex value.
 *
 * The signing protocol is documented in README.md; the exact rules:
 *   message  = input:{i}:{txid}:{index} lines + fee:{fee} + {j}:{address}:{amount} lines
 *              joined with "\n" (UTF-8)
 *   digest   = SHA-256(message)                       (single hash)
 *   signature= ECDSA-SECP256K1(privateKey, digest)    64 bytes r||s, hex
 *   txid     = SHA-256(message + "\n" + signature)    (single hash)
 *   address  = Base58Check(0x21 || RIPEMD160(SHA-256(compressedPubkey)))
 *
 * The broadcastable value is hex(UTF-8 JSON) of:
 *   { inputs, outputs, fee, pubkey, signature }
 * which is what `sendrawtransaction` / `POST /transactions` expects.
 */
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  addressFromPublicKey,
  bytesToHex,
  hexToBytes,
  sha256,
  sha256Hex,
  signMessage,
  transactionMessage,
  validateAddress,
} from "@edgex/shared";

const DERIVATION_PATH = "m/44'/778'/0'/0/0";
const EDX_UNIT = 100_000_000n;

interface Args {
  mnemonic: string | null;
  utxoTxid: string | null;
  utxoIndex: number;
  utxoAmount: string | null;
  to: string | null;
  amount: string | null;
  fee: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const equals = `--${name}=`;
    const hit = argv.find((arg) => arg.startsWith(equals));
    if (hit) return hit.slice(equals.length);
    const flagIndex = argv.indexOf(`--${name}`);
    if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined && !argv[flagIndex + 1]!.startsWith("--")) {
      return argv[flagIndex + 1];
    }
    return undefined;
  };
  const fee = get("fee") ?? "0.00010000";
  if (!/^\d+(\.\d{1,8})?$/.test(fee) || parseEdx(fee) <= 0n) {
    console.error(`Invalid --fee: ${fee}`);
    process.exit(1);
  }
  return {
    mnemonic: get("mnemonic") ?? null,
    utxoTxid: get("utxo-txid") ?? null,
    utxoIndex: Number(get("utxo-index") ?? "0"),
    utxoAmount: get("utxo-amount") ?? null,
    to: get("to") ?? null,
    amount: get("amount") ?? null,
    fee,
  };
}

// ---- Amount helpers (EDX strings with up to 8 decimals; 1 EDX = 10^8 Photons) ----

function parseEdx(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid EDX amount: ${value}`);
  return BigInt(match[1]!) * EDX_UNIT + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
}

function formatEdx(photons: bigint): string {
  const s = photons.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

// ---- Key derivation ----

function deriveKey(mnemonic: string): { privateKeyHex: string; publicKeyHex: string; address: string } {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  if (!hd.privateKey || !hd.publicKey) throw new Error("Key derivation failed");
  const privateKeyHex = bytesToHex(hd.privateKey);
  const publicKeyHex = bytesToHex(hd.publicKey);
  return { privateKeyHex, publicKeyHex, address: addressFromPublicKey(publicKeyHex) };
}

// ---- The signing protocol (see README.md) ----

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

function buildTransaction(inputs: Input[], outputs: Output[], fee: string): TransactionLike {
  return { inputs, outputs, fee };
}

/** Step 2: the exact UTF-8 message text that is hashed and signed. */
function signingMessage(transaction: TransactionLike): string {
  return transactionMessage(transaction);
}

/** Step 3: SHA-256 once over the message, hex. */
function digestHex(transaction: TransactionLike): string {
  return sha256Hex(signingMessage(transaction));
}

/** Step 4: compact secp256k1 signature (r||s, 64 bytes) over the digest. */
function signOffline(privateKeyHex: string, transaction: TransactionLike): string {
  return signMessage(privateKeyHex, signingMessage(transaction));
}

/** Step 5: txid = SHA-256(message + "\n" + signature). */
function transactionId(transaction: TransactionLike, signature: string): string {
  return sha256Hex(`${signingMessage(transaction)}\n${signature}`);
}

/** The broadcastable value: hex(UTF-8 JSON) of the signed body. */
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

// ---- Main ----

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Step 1: mnemonic and address (fully offline).
  const mnemonic = args.mnemonic ?? generateMnemonic(wordlist, 256);
  if (!validateMnemonic(mnemonic, wordlist)) {
    console.error("Invalid BIP39 mnemonic; check the words and spelling.");
    process.exit(1);
  }
  const { privateKeyHex, publicKeyHex, address } = deriveKey(mnemonic);

  console.log("=== EdgeX offline signing demo ===\n");
  console.log(`mnemonic: ${mnemonic}`);
  console.log(`address:  ${address}`);
  console.log(`pubkey:   ${publicKeyHex}\n`);

  // Build the transaction. Without a real UTXO we print an unsigned template
  // so the message format stays visible; with a UTXO we produce a signed,
  // broadcastable value.
  const inputs: Input[] = [];
  if (args.utxoTxid) {
    if (!/^[0-9a-f]{64}$/.test(args.utxoTxid)) {
      console.error(`Invalid --utxo-txid: ${args.utxoTxid}`);
      process.exit(1);
    }
    if (!args.utxoAmount) {
      console.error("--utxo-amount is required when spending a UTXO.");
      process.exit(1);
    }
    inputs.push({ txid: args.utxoTxid.toLowerCase(), index: args.utxoIndex });
  } else {
    inputs.push({ txid: "0".repeat(64), index: 0 });
  }

  const utxoPhotons = inputs.length > 0 && args.utxoAmount ? parseEdx(args.utxoAmount) : 0n;
  const feePhotons = parseEdx(args.fee);
  const to = args.to ?? address;
  if (!validateAddress(to)) {
    console.error(`Invalid --to address: ${to}`);
    process.exit(1);
  }

  // Template mode (no real UTXO): show the message format with a single
  // 0.01 EDX output and no change, so the demo runs without funds.
  if (utxoPhotons === 0n) {
    const outputs: Output[] = [{ address: to, amount: "0.01000000" }];
    const transaction = buildTransaction(inputs, outputs, args.fee);
    console.log("=== signing message (template; supply --utxo-* for a real signed tx) ===\n");
    console.log(signingMessage(transaction));
    console.log("\nSupply --utxo-txid, --utxo-amount (and optionally --amount, --to, --fee) to");
    console.log("produce a signed, broadcastable value.\n");
    return;
  }

  const sendPhotons = args.amount !== null
    ? parseEdx(args.amount)
    : (utxoPhotons - feePhotons) / 2n;
  const changePhotons = utxoPhotons - sendPhotons - feePhotons;
  if (changePhotons < 0n) {
    console.error("Insufficient UTXO: the amount plus fee exceeds the input.");
    process.exit(1);
  }

  const outputs: Output[] = [{ address: to, amount: formatEdx(sendPhotons) }];
  if (changePhotons > 0n) outputs.push({ address, amount: formatEdx(changePhotons) });

  const transaction = buildTransaction(inputs, outputs, args.fee);

  console.log("=== signing message (UTF-8, hashed as-is) ===\n");
  console.log(signingMessage(transaction));
  console.log("\n=== digest (SHA-256, single hash) ===");
  console.log(digestHex(transaction));

  const signature = signOffline(privateKeyHex, transaction);
  console.log("\n=== signature (secp256k1, r||s 64 bytes, hex) ===");
  console.log(signature);

  const txid = transactionId(transaction, signature);
  console.log("\n=== transaction id (SHA-256(message + '\\n' + signature)) ===");
  console.log(txid);

  const hex = broadcastHex(transaction, publicKeyHex, signature);
  console.log("\n=== broadcastable value (hex of UTF-8 JSON) ===");
  console.log(hex);
  console.log("\nSend this hex to the wallet RPC `sendrawtransaction` or POST the");
  console.log("decoded JSON to a node's /transactions endpoint.\n");

  // Self-check: the node recomputes the txid from the same message + signature.
  const recomputed = sha256Hex(
    `${transactionMessage(JSON.parse(Buffer.from(hex, "hex").toString("utf8")))}\n${signature}`,
  );
  if (recomputed !== txid) {
    console.error("Self-check failed: recomputed txid does not match.");
    process.exit(1);
  }
  console.log("Self-check OK: the broadcastable value reproduces the txid.");
}

try {
  main();
} catch (error) {
  console.error(`\nFailed: ${(error as Error).message}`);
  process.exit(1);
}
