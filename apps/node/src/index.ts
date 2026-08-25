#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GENESIS_HASH, Sha256PowVerifier } from '@edgex/core';
import { BlockchainStore } from './storage';
import { ChainService } from './service';
import { P2PNetwork } from './p2p';
import { RpcServer } from './rpc';
import { StratumServer } from './stratum';
import { NativeRandomXVerifier } from './randomx';
import { loadNodeConfig } from './config';

async function main(): Promise<void> {
  const config = loadNodeConfig();
  if (!config.nativeRandomX && !config.allowTestPow) {
    throw new Error('refusing to start without native RandomX; set EDX_RANDOMX_NATIVE=1 or EDX_ALLOW_TEST_POW=1');
  }
  mkdirSync(config.dataDir, { recursive: true });
  const store = new BlockchainStore(`${config.dataDir}/chain.sqlite`);
  const verifier = config.nativeRandomX ? new NativeRandomXVerifier(config.randomXLibrary) : new Sha256PowVerifier();
  const service = new ChainService(verifier, store, config.networkId);
  const nodeId = randomUUID();
  const rpc = new RpcServer({
    host: config.rpcHost,
    port: config.rpcPort,
    service,
  });

  const stratum = new StratumServer(config.stratumHost, config.stratumPort, service);
  let network: P2PNetwork;
  network = new P2PNetwork(
    config.p2pPort,
    nodeId,
    () => ({ height: service.chain.height, bestHash: service.chain.bestBlockHash }),
    (transaction) => service.acceptTransaction(transaction),
    (block) => {
      try {
        service.acceptBlock(block);
      } catch {
        // Invalid peer blocks are rejected without disconnecting the peer.
      }
    },
  );
  service.onTransactionAccepted = (transaction) => {
    network.broadcast({ type: 'transaction', transaction });
  };
  service.onBlockAccepted = (block) => {
    network.broadcast({ type: 'block', block });
    stratum.notifyNewTip();
  };
  network.setRpcHandler(async (method, path, body) => {
    const request = new Request(`http://p2p.local${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const response = await rpc.handle(request);
    return { status: response.status, data: await response.json() };
  });
  network.start(config.seeds);

  service.peerStatus = () => ({ connected: network.peerCount, total: network.peerCount });

  rpc.start();

  stratum.start();

  console.log(`EdgeX node ${nodeId} started: genesis=${GENESIS_HASH}`);
  console.log(`RPC=http://${config.rpcHost}:${config.rpcPort} P2P=:${config.p2pPort} Stratum=:${config.stratumPort}`);

  const shutdown = (): void => {
    network.stop();
    rpc.stop();
    stratum.stop();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
