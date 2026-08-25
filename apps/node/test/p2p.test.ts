import { describe, expect, test } from "bun:test";
import { P2PNetwork, reconnectDelayMs } from "../src/p2p";
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

describe("P2P peer maintenance", () => {
  test("discovers advertised peers through a seed neighbor", async () => {
    const a = new P2PNetwork(
      0,
      "discovery-node-a",
      () => ({ height: 1, bestHash: "a".repeat(64) }),
      () => {},
      () => {},
    );
    const b = new P2PNetwork(
      0,
      "discovery-node-b",
      () => ({ height: 1, bestHash: "a".repeat(64) }),
      () => {},
      () => {},
    );
    const c = new P2PNetwork(
      0,
      "discovery-node-c",
      () => ({ height: 1, bestHash: "a".repeat(64) }),
      () => {},
      () => {},
    );
    a.start([]);
    b.start([]);
    c.start([]);
    const aUrl = `ws://127.0.0.1:${a.boundPort}/p2p`;
    const bUrl = `ws://127.0.0.1:${b.boundPort}/p2p`;
    a.setPublicUrl(aUrl);
    b.setPublicUrl(bUrl);
    c.setPublicUrl(`ws://127.0.0.1:${c.boundPort}/p2p`);

    try {
      // Seeds may omit the canonical WebSocket path for backward compatibility.
      b.connect(aUrl.replace(/\/p2p$/, ""));
      await waitFor(() => a.peerCount === 1 && b.peerCount === 1);

      c.connect(bUrl.replace(/\/p2p$/, ""));
      await waitFor(() => c.peerCount >= 2);
      expect(c.knownPeerUrls()).toContain(aUrl);
      expect(c.outboundSnapshot().filter((peer) => peer.connected)).toHaveLength(2);
    } finally {
      a.stop();
      b.stop();
      c.stop();
    }
  });

  test("schedules capped exponential reconnects when an outbound link closes", async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);

    const network = new P2PNetwork(
      0,
      "reconnect-node-123",
      () => ({ height: 0, bestHash: "" }),
      () => {},
      () => {},
      undefined,
      () => {
        const socket = new ReconnectSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
    const sockets: ReconnectSocket[] = [];
    network.start([]);
    try {
      network.connect("ws://127.0.0.1:9/p2p");
      await waitFor(() => sockets.length === 1);
      expect(network.outboundSnapshot()[0]?.connected).toBe(false);

      sockets[0]!.close();
      await waitFor(() => network.outboundSnapshot()[0]?.reconnecting === true);
      expect(network.outboundSnapshot()[0]?.attempts).toBe(1);
    } finally {
      network.stop();
    }
  });
});

class ReconnectSocket extends EventTarget {
  readyState = WebSocket.CLOSED;

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("P2P condition was not reached");
}
