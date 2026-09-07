import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENESIS_BLOCK } from '@edgex/core';
import type { Block } from '@edgex/core';
import { MINER, buildBlock, mineBlocks, startNode, waitFor } from './helpers';

describe('P2P block synchronization', () => {
  const root = mkdtempSync(join(tmpdir(), 'edgex-p2p-sync-'));
  const running: Array<ReturnType<typeof startNode>> = [];
  let caseDirectory = '';

  beforeEach(() => {
    caseDirectory = join(root, `case-${Math.random().toString(36).slice(2)}`);
    mkdirSync(caseDirectory, { recursive: true });
  });

  afterEach(() => {
    for (const node of running) node.network.stop();
    for (const node of running) node.store.close();
    running.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test('catches up a lagging node over the peer link', async () => {
    const ahead = startNode(caseDirectory, 'ahead');
    const behind = startNode(caseDirectory, 'behind', [ahead.url]);
    running.push(ahead, behind);

    await waitFor(() => ahead.network.peerCount === 1 && behind.network.peerCount === 1);
    mineBlocks(ahead.service, MINER, 10);
    expect(ahead.service.chain.height).toBe(10);

    // The periodic peer sync pass pulls the missing blocks from the peer.
    await waitFor(() => behind.service.chain.height === 10, 8_000);
    expect(behind.service.chain.bestBlockHash).toBe(ahead.service.chain.bestBlockHash);
    expect(behind.store.count()).toBe(11); // genesis + ten blocks
  }, 20_000);

  test('does not re-download blocks once both chains are aligned', async () => {
    const ahead = startNode(caseDirectory, 'ahead-aligned');
    const behind = startNode(caseDirectory, 'behind-aligned', [ahead.url]);
    running.push(ahead, behind);

    await waitFor(() => ahead.network.peerCount === 1 && behind.network.peerCount === 1);
    mineBlocks(ahead.service, MINER, 5, GENESIS_BLOCK.header.timestampSeconds + 30);
    await waitFor(() => behind.service.chain.height === 5, 8_000);

    const fetched = behind.network.blocksFetchedCount;
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(behind.network.blocksFetchedCount).toBe(fetched);
    // The handshake exchanges advertised peer lists, so full nodes typically
    // end up mutually connected; the link must stay healthy after alignment.
    expect(behind.network.peerCount).toBeGreaterThanOrEqual(1);
    expect(ahead.network.peerCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  test('rejects an invalid peer block without disconnecting the peer', async () => {
    const ahead = startNode(caseDirectory, 'ahead-badblock');
    const behind = startNode(caseDirectory, 'behind-badblock', [ahead.url]);
    running.push(ahead, behind);

    await waitFor(() => ahead.network.peerCount === 1 && behind.network.peerCount === 1);

    // Broadcast a block whose previous hash points at a parent nobody knows.
    // Consensus throws "unknown previous block"; the receiving node must count
    // the rejection, keep the link open and keep running.
    const valid = buildBlock(
      behind.service.chain.get(behind.service.chain.bestBlockHash).block,
      GENESIS_BLOCK.header.timestampSeconds + 30,
      MINER,
    );
    const bogus: Block = {
      ...valid,
      header: { ...valid.header, previousHash: 'deadbeef'.repeat(8) },
    };
    // BigInt fields travel as decimal strings over the wire; rehydrate on receipt.
    const wireBlock = {
      ...bogus,
      header: { ...bogus.header, difficulty: bogus.header.difficulty.toString() },
    };
    behind.network.broadcast({ type: 'block', block: wireBlock as unknown as Block });

    await waitFor(() => ahead.network.rejectedPeerBlockCount >= 1, 3_000);
    expect(ahead.service.chain.height).toBe(0); // nothing was accepted
    // The offending peer is not disconnected: the gossip link stays healthy.
    expect(ahead.network.peerCount).toBeGreaterThanOrEqual(1);
    expect(behind.network.peerCount).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
