import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDX_UNIT,
  addressFromPublicKey,
  formatEdxAmount,
  generateKeyPair,
  signTransaction,
} from "@edgex/shared";
import { GENESIS_BLOCK } from "@edgex/core";
import type { PowVerifier } from "@edgex/core";
import { BlockchainStore } from "../src/storage";
import { ChainService } from "../src/service";

class AcceptedVerifier implements PowVerifier {
  verify(_blob: Uint8Array, claimedHashHex: string): boolean {
    return /^[0-9a-f]{64}$/.test(claimedHashHex);
  }
}

describe("node wallet service", () => {
  const directory = mkdtempSync(join(tmpdir(), "edgex-node-"));
  const store = new BlockchainStore(join(directory, "chain.sqlite"));

  afterEach(() => {
    const realNow = Date.now;
    Date.now = realNow;
  });

  test("exposes pending transfers before confirmation, matching the legacy wallet history", () => {
    const service = new ChainService(new AcceptedVerifier(), store, "test-network");
    const { privateKeyHex, publicKeyHex } = generateKeyPair();
    const sender = addressFromPublicKey(publicKeyHex);
    const recipient = addressFromPublicKey(generateKeyPair().publicKeyHex);
    let clock = GENESIS_BLOCK.header.timestampSeconds * 1000 + 1_000;
    const originalNow = Date.now;
    Date.now = () => (clock += 16_000);

    try {
      for (let index = 0; index < 7; index += 1) {
        const job = service.createJob(sender);
        const proof = (index + 1).toString(16).padStart(64, "0");
        const submitted = service.submitShare(job.jobId, "01000000", proof);
        expect(submitted.result).toBe("extended");
      }

      const utxo = service.chain.stateAt(service.chain.bestBlockHash).spendable(sender, 7)[0]!;
      const fee = 10_000_000n;
      const transfer = signTransaction(
        {
          inputs: [{ txid: utxo.txid, index: utxo.index }],
          outputs: [{ address: recipient, amount: formatEdxAmount(utxo.amountPhotons - fee) }],
          fee: formatEdxAmount(fee),
        },
        privateKeyHex,
      );
      service.acceptTransaction(transfer);

      const sentPending = service.history(sender, 10).find((item) => item.txid !== "" && item.category === "send");
      expect(sentPending?.status).toBe("pending");
      expect(sentPending?.height).toBeNull();
      const receivedPending = service.history(recipient, 10).at(-1);
      expect(receivedPending?.status).toBe("pending");

      const confirmingJob = service.createJob(sender);
      expect(confirmingJob.block.transactions.map((transaction) => transaction.signature)).toContain(transfer.signature);
      const confirmingProof = (1000).toString(16).padStart(64, "0");
      expect(service.submitShare(confirmingJob.jobId, "02000000", confirmingProof).result).toBe("extended");
      expect(service.history(sender, 100).some((item) => item.status === "pending")).toBe(false);
      expect(service.history(recipient, 100).some((item) => item.category === "receive" && item.height === 8)).toBe(true);
    } finally {
      Date.now = originalNow;
      store.close();
    }
  });
});
