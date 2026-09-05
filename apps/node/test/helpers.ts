import { addressFromPublicKey, bytesToHex, formatEdxAmount, generateKeyPair, sha256, transactionId } from '@edgex/shared';
import { calculateMerkleRoot, ConsensusChain, GENESIS_HASH, GENESIS_BLOCK, serializeMiningBlob } from '@edgex/core';
import type { Block, BlockHeader, PowVerifier } from '@edgex/core';
import { BlockchainStore } from '../src/storage';
import { ChainService } from '../src/service';
import { P2PNetwork } from '../src/p2p';

/** Test verifier that accepts any well-formed 64-hex hash (no real proof-of-work). */
export class AcceptedVerifier implements PowVerifier {
  verify(_blob: Uint8Array, claimedHashHex: string): boolean {
    return /^[0-9a-f]{64}$/.test(claimedHashHex);
  }
}

export const MINER = addressFromPublicKey(generateKeyPair().publicKeyHex);

/**
 * Build a valid block on top of the given parent. Timestamps must increase so
 * the consensus median rule stays satisfied; the bootstrap difficulty and
 * RandomX seed are constant, matching the deterministic chain used by the
 * consensus tests.
 */
export function buildBlock(
  parent: Block,
  timestampSeconds: number,
  payoutAddress: string,
  transactions: Block['transactions'] = [],
): Block {
  const height = parent.header.height + 1;
  const subsidy = 400n * 100_000_000n; // Bootstrap phase subsidy.
  const coinbase = { outputs: [{ address: payoutAddress, amount: formatEdxAmount(subsidy) }] };
  const txids = transactions.map((transaction) => transactionId(transaction));
  const header: BlockHeader = {
    version: 1,
    height,
    previousHash: parent.hash,
    timestampSeconds,
    difficulty: parent.header.difficulty,
    merkleRoot: calculateMerkleRoot(height, coinbase, txids),
    powSeed: GENESIS_HASH,
    payoutAddress,
  };
  const nonce = timestampSeconds % 1_000_000;
  return {
    header,
    hash: bytesToHex(sha256(serializeMiningBlob(header, nonce))),
    nonce,
    coinbase,
    transactions,
  };
}

/** Extend the best chain of a service with the given number of valid blocks. */
export function mineBlocks(service: ChainService, address: string, count: number, firstTimestamp = GENESIS_BLOCK.header.timestampSeconds + 20): void {
  for (let index = 0; index < count; index += 1) {
    const parent = service.chain.get(service.chain.bestBlockHash).block;
    const block = buildBlock(parent, firstTimestamp + index * 20, address);
    service.acceptBlock(block);
  }
}

export interface RunningNode {
  service: ChainService;
  store: BlockchainStore;
  network: P2PNetwork;
  url: string;
}

/**
 * Start a full node with a real consensus chain and a peer layer that accepts
 * downloaded blocks through consensus. The network listens on an ephemeral
 * port and connects to every supplied seed.
 */
export function startNode(directory: string, tag: string, seeds: readonly string[] = []): RunningNode {
  const store = new BlockchainStore(`${directory}/chain-${tag}.sqlite`);
  const service = new ChainService(new AcceptedVerifier(), store, 'test-network');
  const network = new P2PNetwork(
    0,
    `test-${tag}`,
    () => ({ height: service.chain.height, bestHash: service.chain.bestBlockHash }),
    () => undefined,
    (block) => {
      try {
        service.acceptBlock(block);
      } catch {
        // Invalid peer blocks are rejected without disconnecting the peer.
      }
    },
  );
  network.setPeerDataSource({
    status: () => {
      const hash = service.chain.bestBlockHash;
      const totalWork = service.chain.cumulativeWorkFrom(hash) ?? 0n;
      return { height: service.chain.height, bestHash: hash, totalWork: totalWork.toString() };
    },
    chainAtHeight: (height) => service.chain.chainAtHeight(height),
    cumulativeWorkFrom: (hash) => service.chain.cumulativeWorkFrom(hash),
    has: (hash) => service.chain.has(hash),
    peerStatus: () => ({ connected: network.peerCount, total: 0, items: [] }),
  });
  service.onBlockAccepted = () => network.notifyChainAdvanced();
  network.start(seeds);
  const url = `ws://127.0.0.1:${network.boundPort}/p2p`;
  network.setPublicUrl(url);
  return { service, store, network, url };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('condition was not reached');
}

export function tipTimestamp(service: ChainService): number {
  return service.chain.get(service.chain.bestBlockHash).block.header.timestampSeconds;
}

export type { Block };
export { ConsensusChain };
