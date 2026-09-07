import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { NETWORK_ID } from "@edgex/shared";
import { ConnectionManager, reconnectDelayMs } from "../src/core/connection";
import { Logger } from "../src/utils/log";

/**
 * A controllable loopback WebSocket peer that answers the wallet handshake so
 * a PeerLink considers the connection established. The server keeps listening
 * after dropAll(), which lets a test drop the live link and then observe the
 * wallet reconnect to the same endpoint.
 */
interface TestPeerServer {
  url: string;
  sockets: Array<ServerWebSocket<Record<string, never>>>;
  dropAll(): void;
  stop(): void;
}

function startPeerServer(): TestPeerServer {
  const sockets: Array<ServerWebSocket<Record<string, never>>> = [];
  const server = Bun.serve<Record<string, never>>({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("WebSocket endpoint", { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.push(socket);
      },
      message(socket, message) {
        let frame: unknown;
        try {
          frame = JSON.parse(String(message));
        } catch {
          return;
        }
        const value = frame as { type?: string };
        if (value.type === "hello") {
          socket.send(JSON.stringify({ type: "hello", networkId: NETWORK_ID }));
        } else if (value.type === "rpc_request") {
          // Answer the wallet's info request so the probe completes.
          socket.send(
            JSON.stringify({
              type: "rpc_result",
              id: (value as { id?: string }).id,
              status: 200,
              data: { ok: true },
            }),
          );
        }
      },
      close(socket) {
        const index = sockets.indexOf(socket);
        if (index >= 0) sockets.splice(index, 1);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/p2p`,
    sockets,
    dropAll() {
      for (const socket of [...sockets]) socket.close();
    },
    stop() {
      server.stop(true);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("wallet reconnect condition was not reached");
}

describe("wallet peer link reconnect", () => {
  const peers: TestPeerServer[] = [];
  const managers: ConnectionManager[] = [];

  function makeManager(url: string): ConnectionManager {
    const manager = new ConnectionManager({
      nodeUrl: url,
      configuredNodes: [],
      nodeId: "test-wallet-node",
      log: new Logger(),
    });
    managers.push(manager);
    return manager;
  }

  afterEach(() => {
    for (const manager of managers) manager.stop();
    managers.length = 0;
    for (const peer of peers) peer.stop();
    peers.length = 0;
  });

  test("reconnect delays grow exponentially and cap at the maximum", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  test("reconnects a dropped link before the next periodic sweep", async () => {
    const peer = startPeerServer();
    peers.push(peer);
    const manager = makeManager(peer.url);

    expect(await manager.refreshConnection()).toBe(true);
    await waitFor(() => peer.sockets.length >= 1);
    expect(manager.connectedCount).toBe(1);

    // Dropping the server-side socket closes the established link. The close
    // notification must schedule a backoff reconnect immediately instead of
    // leaving the peer disconnected until the 15s sweep.
    peer.dropAll();
    await waitFor(() => {
      const state = manager.reconnectSnapshot()[0];
      return state !== undefined && state.reconnectPending && !state.connected;
    }, 2_000);

    // The endpoint is still listening, so the first backoff attempt succeeds.
    await waitFor(() => manager.connectedCount === 1, 5_000);
    const state = manager.reconnectSnapshot()[0]!;
    expect(state.connected).toBe(true);
    expect(state.reconnectAttempts).toBe(0);
    expect(state.reconnectPending).toBe(false);
  });

  test("keeps retrying an unreachable peer with growing backoff", async () => {
    // Port 9 (discard) is not listening, so every connect attempt fails.
    const manager = makeManager("ws://127.0.0.1:9/p2p");

    expect(await manager.refreshConnection()).toBe(false);
    const afterFirst = manager.reconnectSnapshot()[0]!;
    expect(afterFirst.connected).toBe(false);
    expect(afterFirst.reconnectAttempts).toBe(1);
    expect(afterFirst.reconnectPending).toBe(true);

    // The first backoff (1s) fires, fails again, and schedules the next step.
    await waitFor(() => manager.reconnectSnapshot()[0]?.reconnectAttempts === 2, 4_000);
    expect(manager.connectedCount).toBe(0);
  });
});
