import type { Block } from "@edgex/core";
import type { SignedTransaction } from "@edgex/shared";
import type { ConnectionManager } from "./connection";

/**
 * Block submission support for the wallet RPC surface.
 *
 * The wallet never validates or stores blocks itself: consensus lives in the
 * full node. `submitblock` therefore decodes the hex-encoded block body that
 * the caller produced (hex of UTF-8 JSON, the same convention as raw
 * transactions) and forwards it to the connected node's `/blocks` endpoint,
 * where the real consensus pipeline (merkle root, proof of work, difficulty,
 * timestamps, UTXO state, signatures) accepts or rejects it.
 *
 * The node responds with the acceptance result:
 *   'extended'  -> the block extended the best chain  (accept)
 *   'fork'      -> the block built on a side branch   (inconclusive)
 *   'known'     -> the block hash is already known    (duplicate)
 *   HTTP 400    -> the block failed consensus checks  (rejected)
 *
 * These map to the bitcoind `submitblock` status strings so existing tooling
 * keeps working against the decentralized wallet.
 */

export type SubmitBlockStatus = "duplicate" | "inconclusive" | "rejected";

export interface SubmitBlockResult {
  /** null when the block was accepted and extended the best chain. */
  status: SubmitBlockStatus | null;
  /** Present when the block was rejected or could not be validated. */
  rejectReason?: string;
}

function isHex(value: string): boolean {
  return /^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSignedTransaction(value: unknown): value is SignedTransaction {
  if (typeof value !== "object" || value === null) return false;
  const tx = value as Record<string, unknown>;
  if (!Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) return false;
  if (typeof tx.fee !== "string" || typeof tx.pubkey !== "string" || typeof tx.signature !== "string") {
    return false;
  }
  return tx.inputs.every(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      typeof (input as Record<string, unknown>).txid === "string" &&
      typeof (input as Record<string, unknown>).index === "number",
  );
}

/**
 * Decode a `submitblock` hex payload into the consensus `Block` shape.
 * The wire format is hex(UTF-8 JSON) of the block body, matching the raw
 * transaction convention. Returns null when the payload cannot be decoded
 * into a structurally valid block.
 */
export function decodeBlockHex(hex: string): Block | null {
  if (typeof hex !== "string" || !isHex(hex)) return null;
  let raw: string;
  try {
    raw = Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const block = parsed as Record<string, unknown>;
  if (typeof block.header !== "object" || block.header === null) return null;
  const header = block.header as Record<string, unknown>;
  if (typeof header.version !== "number" || typeof header.height !== "number") return null;
  if (!isHash(header.previousHash) || !isHash(header.merkleRoot) || !isHash(header.powSeed)) return null;
  if (typeof header.timestampSeconds !== "number" || typeof header.payoutAddress !== "string") return null;
  if (typeof block.hash !== "string" || !isHash(block.hash)) return null;
  if (typeof block.nonce !== "number") return null;

  const difficulty = BigInt(String(header.difficulty ?? "0"));
  if (difficulty < 1n) return null;

  if (block.coinbase !== null && typeof block.coinbase !== "object") return null;
  const coinbase = block.coinbase as { outputs?: unknown } | null;
  if (coinbase !== null) {
    if (!Array.isArray(coinbase.outputs)) return null;
    for (const output of coinbase.outputs) {
      if (
        typeof output !== "object" ||
        output === null ||
        typeof (output as Record<string, unknown>).address !== "string" ||
        typeof (output as Record<string, unknown>).amount !== "string"
      ) {
        return null;
      }
    }
  }

  if (!Array.isArray(block.transactions) || !block.transactions.every(isSignedTransaction)) return null;

  return {
    header: {
      version: header.version,
      height: header.height,
      previousHash: header.previousHash,
      timestampSeconds: header.timestampSeconds,
      difficulty,
      merkleRoot: header.merkleRoot,
      powSeed: header.powSeed,
      payoutAddress: header.payoutAddress,
    },
    hash: block.hash,
    nonce: block.nonce,
    coinbase: coinbase as Block["coinbase"],
    transactions: block.transactions as SignedTransaction[],
  };
}

/**
 * Submit a decoded block to the connected node's real consensus pipeline.
 * Returns a bitcoind-style status plus an optional rejection reason.
 */
export async function submitBlock(
  conn: ConnectionManager,
  block: Block,
): Promise<SubmitBlockResult> {
  let result: unknown;
  try {
    result = await conn.request<{ result?: string }>("POST", "/blocks", block);
  } catch (error) {
    const detail = (error as Error).message ?? "unknown error";
    return { status: "rejected", rejectReason: detail };
  }
  const status = (result as { result?: string }).result;
  switch (status) {
    case "extended":
      // The block extended the best chain; the node persisted and broadcast it.
      return { status: null };
    case "fork":
      // The block built on a side branch; it is valid but not the best chain.
      return { status: "inconclusive" };
    case "known":
      // The block hash is already known to the node.
      return { status: "duplicate" };
    default:
      return { status: "rejected", rejectReason: `node rejected block: ${String(status)}` };
  }
}
