import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENESIS_BLOCK, GENESIS_HASH } from '@edgex/core';
import { buildBlock, MINER, startNode, waitFor } from './helpers';
import type { RunningNode } from './helpers';
import type { Block } from '@edgex/core';

// Timestamps must strictly increase block over block (consensus median rule)
// but stay well inside the past so the future tolerance check never trips.
// Genesis is fixed at 2026-01-01, so offsets measured from it are safe.
const BASE_TS = GENESIS_BLOCK.header.timestampSeconds + 60;
const STEP_TS = 20;

/**
 * Let the peer `candidate` grow a competing chain that forks off the
 * `reference` chain at the given local height and extends until it is `extra`
 * blocks past the reference tip. The reference chain itself is untouched.
 * Returns the fork tip block. Consensus accepts a fork silently; the peer
 * layer only switches when the candidate branch carries strictly more work.
 */
function growForkOff(
  reference: RunningNode,
  candidate: RunningNode,
  forkAtHeight: number,
  extra: number,
): Block {
  const parent = reference.service.chain.chainAtHeight(forkAtHeight)!;
  const blocks: Block[] = [];
  let tip = parent;
  const targetHeight = reference.service.chain.height + extra;
  for (let index = 0; index < targetHeight - forkAtHeight; index += 1) {
    const block = buildBlock(tip, BASE_TS + index * STEP_TS, MINER);
    candidate.service.acceptBlock(block);
    blocks.push(block);
    tip = block;
  }
  return blocks[blocks.length - 1]!;
}

describe('P2P reorganization to a heavier fork', () => {
  const root = mkdtempSync(join(tmpdir(), 'edgex-p2p-reorg-'));
  const running: RunningNode[] = [];
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

  test('switches a forked node to the heavier candidate chain', async () => {
    const base = startNode(caseDirectory, 'base');
    const forked = startNode(caseDirectory, 'forked', [base.url]);
    running.push(base, forked);

    await waitFor(() => base.network.peerCount >= 1 && forked.network.peerCount >= 1);

    // Both nodes share genesis; the base node extends straight while the
    // forked node builds a competing heavier branch from the same start.
    const forkTip = growForkOff(base, forked, 0, 5);
    expect(forked.service.chain.height).toBe(5);
    expect(base.service.chain.height).toBe(0);

    // The fork is heavier (its cumulative work exceeds the base chain), so the
    // base node must fetch it and reorganize onto the fork tip.
    await waitFor(() => base.service.chain.bestBlockHash === forkTip.hash, 10_000);
    expect(base.service.chain.height).toBe(5);
    expect(base.service.chain.bestBlockHash).toBe(forked.service.chain.bestBlockHash);
  });

  test('reverts a node that mined a losing branch once a heavier fork appears', async () => {
    const base = startNode(caseDirectory, 'base-miner');
    const forked = startNode(caseDirectory, 'forked-miner', [base.url]);
    running.push(base, forked);

    await waitFor(() => base.network.peerCount >= 1 && forked.network.peerCount >= 1);

    // The base node mines 2 blocks of its own branch (height 2), then the
    // peer builds a 5-block competing branch that forks at the genesis.
    const mineOne = (node: RunningNode, ts: number): Block => {
      const parent = node.service.chain.get(node.service.chain.bestBlockHash).block;
      const block = buildBlock(parent, ts, MINER);
      node.service.acceptBlock(block);
      return block;
    };
    const ownTip = mineOne(base, BASE_TS);
    mineOne(base, BASE_TS + STEP_TS);
    expect(base.service.chain.height).toBe(2);
    expect(base.service.chain.chainAtHeight(1)!.hash).toBe(ownTip.hash);

    // Peer forks at the genesis (replacing base's own blocks) and extends to 5.
    const forkBlocks: Block[] = [];
    let tip = base.service.chain.chainAtHeight(0)!;
    for (let index = 0; index < 5; index += 1) {
      const block = buildBlock(tip, BASE_TS + 200 + index * STEP_TS, MINER);
      forked.service.acceptBlock(block);
      forkBlocks.push(block);
      tip = block;
    }
    const heavierTip = forkBlocks[forkBlocks.length - 1]!;

    await waitFor(() => base.service.chain.bestBlockHash === heavierTip.hash, 10_000);
    expect(base.service.chain.height).toBe(5);
    expect(base.service.chain.bestBlockHash).toBe(forked.service.chain.bestBlockHash);
  });
});
