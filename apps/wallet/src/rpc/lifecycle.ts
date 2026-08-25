import type { Logger } from "../utils/log";
import type { WalletConfig } from "../config/config";
import type { WalletCore } from "../core/walletCore";
import { WalletRpcServer } from "./server";

/**
 * Start the local wallet RPC only when its required configuration is present.
 * Returning null keeps TUI-only and misconfigured wallets usable without a port.
 */
export function startWalletRpc(
  config: WalletConfig,
  core: WalletCore,
  log: Logger,
): WalletRpcServer | null {
  if (!config.server) {
    log.info("Wallet RPC disabled by server=0");
    return null;
  }
  if (!config.rpcuser || !config.rpcpassword) {
    log.warn("Wallet RPC not started: rpcuser/rpcpassword is not configured");
    return null;
  }
  if (config.rpcport === undefined) {
    log.warn("Wallet RPC not started: rpcport is not configured");
    return null;
  }

  const server = new WalletRpcServer(config, core, log);
  try {
    server.start();
  } catch (error) {
    log.error(`Wallet RPC startup failed: ${(error as Error).message}`);
    server.stop();
    return null;
  }
  return server.listening ? server : null;
}
