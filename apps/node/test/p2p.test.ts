import { describe, expect, test } from "bun:test";
import { P2PNetwork } from "../src/p2p";
import { PeerLink } from "../../wallet/src/core/peerLink";

describe("P2P request links", () => {
  test("serves the public node API over a wallet peer link", async () => {
    const network = new P2PNetwork(
      0,
      "test-node-12345",
      () => ({ height: 9, bestHash: "a".repeat(64) }),
      () => {},
      () => {},
    );
    network.setRpcHandler(async () => ({ status: 200, data: { height: 9, ok: true } }));
    network.start([]);

    const link = new PeerLink({
      url: `ws://127.0.0.1:${network.boundPort}`,
      nodeId: "test-wallet-12345",
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(link.request<Record<string, unknown>>("GET", "/chain/info")).resolves.toMatchObject({ height: 9 });
    } finally {
      link.close();
      network.stop();
    }
  });

  test("rejects malformed paths without invoking consensus", async () => {
    const network = new P2PNetwork(
      0,
      "test-node-12345",
      () => ({ height: 0, bestHash: "" }),
      () => {},
      () => {},
    );
    let invoked = false;
    network.setRpcHandler(async () => {
      invoked = true;
      return { status: 200, data: {} };
    });
    network.start([]);
    const link = new PeerLink({ url: `ws://127.0.0.1:${network.boundPort}`, nodeId: "test-wallet-12345" });
    try {
      await expect(link.request("GET", "/../secret")).rejects.toThrow(/invalid P2P RPC request/);
      expect(invoked).toBe(false);
    } finally {
      link.close();
      network.stop();
    }
  });
});
