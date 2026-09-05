import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_PORTS, NETWORK_ID } from '@edgex/shared';

export interface NodeConfig {
  networkId: string;
  dataDir: string;
  rpcHost: string;
  rpcPort: number;
  p2pPort: number;
  stratumHost: string;
  stratumPort: number;
  nativeRandomX: boolean;
  allowTestPow: boolean;
  randomXLibrary?: string | undefined;
  seeds: string[];
  publicUrl?: string | undefined;
  nodeId?: string | undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function loadNodeConfig(environment: NodeJS.ProcessEnv = process.env): NodeConfig {
  return {
    networkId: environment.EDX_NETWORK_ID ?? NETWORK_ID,
    dataDir: environment.EDX_DATA_DIR ?? './data',
    rpcHost: environment.EDX_RPC_HOST ?? '127.0.0.1',
    rpcPort: positiveInteger(environment.EDX_RPC_PORT, DEFAULT_PORTS.rpc),
    p2pPort: positiveInteger(environment.EDX_P2P_PORT, DEFAULT_PORTS.p2p),
    stratumHost: environment.EDX_STRATUM_HOST ?? '0.0.0.0',
    stratumPort: positiveInteger(environment.EDX_STRATUM_PORT, DEFAULT_PORTS.stratum),
    nativeRandomX: environment.EDX_RANDOMX_NATIVE === '1',
    allowTestPow: environment.EDX_ALLOW_TEST_POW === '1',
    randomXLibrary: environment.EDX_RANDOMX_LIBRARY,
    publicUrl: environment.EDX_PUBLIC_URL?.trim() || undefined,
    seeds: (environment.EDX_SEEDS ?? '')
      .split(',')
      .map((seed) => seed.trim())
      .filter((seed) => /^wss?:\/\/[\w.:-]+$/.test(seed)),
    nodeId: environment.EDX_NODE_ID?.trim() || undefined,
  };
}

/**
 * Return the stable identity of this node. An explicitly configured identity
 * wins; otherwise a random one is generated once and persisted next to the
 * chain database so every process restart advertises the same node id.
 */
export function loadOrCreateNodeId(dataDir: string, configured?: string | undefined): string {
  if (configured && /^[\w:-]{8,80}$/.test(configured)) return configured;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'node.id');
  try {
    const persisted = readFileSync(file, 'utf8').trim();
    if (/^[\w:-]{8,80}$/.test(persisted)) return persisted;
  } catch {
    // The identity file does not exist yet; a fresh id is created below.
  }
  const fresh = randomUUID();
  try {
    writeFileSync(file, fresh, { mode: 0o600 });
  } catch {
    // A read-only data directory still works for this process; the id is
    // simply not remembered across restarts.
  }
  return fresh;
}
