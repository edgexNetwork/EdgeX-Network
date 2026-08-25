import { describe, expect, test } from "bun:test";
import { startWalletRpc } from "../src/rpc/lifecycle";
import { Logger } from "../src/utils/log";
import type { WalletConfig } from "../src/config/config";
import type { WalletCore } from "../src/core/walletCore";

function createConfig(overrides: Partial<WalletConfig> = {}): WalletConfig {
  return {
    datadir: ".",
    confPath: "dexcoin.conf",
    server: true,
    rpcuser: "edx",
    rpcpassword: "edx-secret",
    rpcport: 0,
    listen: false,
    addnodes: [],
    ...overrides,
  };
}

const logger = new Logger();

describe("wallet RPC lifecycle", () => {
  test("starts a configured loopback JSON-RPC server", () => {
    const core = {} as WalletCore;
    const server = startWalletRpc(createConfig(), core, logger);
    try {
      expect(server?.listening).toBe(true);
    } finally {
      server?.stop();
    }
  });

  test("does not bind a disabled or incomplete RPC configuration", () => {
    expect(startWalletRpc(createConfig({ server: false }), {} as WalletCore, logger)).toBeNull();
    expect(startWalletRpc(createConfig({ rpcuser: "" }), {} as WalletCore, logger)).toBeNull();
    expect(startWalletRpc(createConfig({ rpcport: undefined }), {} as WalletCore, logger)).toBeNull();
  });

  test("serves the authenticated network hash-rate method", async () => {
    const core = {
      getChainInfo: async () => ({ blocks: 12, connectedNodes: 2 }),
      getMiningInfo: async () => ({ difficulty: "1000000", networkHashps: 66_667, hashrate: 0 }),
    } as unknown as WalletCore;
    const server = startWalletRpc(createConfig(), core, logger);
    const authorization = `Basic ${btoa("edx:edx-secret")}`;

    try {
      const response = await server!.handle(new Request("http://127.0.0.1/", {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getnetworkhashps", params: [] }),
      }));
      const payload = await response.json() as { result: number };
      expect(payload.result).toBe(66_667);
    } finally {
      server?.stop();
    }
  });
});
