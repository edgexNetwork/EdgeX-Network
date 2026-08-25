import { describe, expect, test } from 'bun:test';
import {
  EDX_UNIT,
  addressFromPublicKey,
  bytesToHex,
  formatEdxAmount,
  generateKeyPair,
  sha256,
  signTransaction,
  transactionId,
} from '@edgex/shared';
import {
  ConsensusChain,
  GENESIS_BLOCK,
  calculateMerkleRoot,
  expectedSeedHeight,
  nextLwmaDifficulty,
  readNonce,
  serializeMiningBlob,
  targetForDifficulty,
} from '../src';
import type { PowVerifier } from '../src';
import type { Block, BlockHeader } from '../src';

class TestVerifier implements PowVerifier {
  verify(_blob: Uint8Array, claimedHashHex: string): boolean {
    return /^[0-9a-f]{64}$/.test(claimedHashHex);
  }
}

function makeChain(): ConsensusChain {
  return new ConsensusChain(new TestVerifier(), () => GENESIS_BLOCK.header.timestampSeconds * 1000 + 60_000);
}

function buildBlock(
  chain: ConsensusChain,
  payout: string,
  timestampSeconds: number,
  transactions: Block['transactions'] = [],
  parentHash: string = chain.bestBlockHash,
): Block {
  const parent = chain.get(parentHash).block;
  const height = parent.header.height + 1;
  // The first 518,400 blocks all receive the fixed bootstrap subsidy.
  const subsidy = parent.header.height < 518_400 ? 400n * EDX_UNIT : 902n * EDX_UNIT;
  const coinbase = { outputs: [{ address: payout, amount: formatEdxAmount(subsidy) }] };
  const txids = transactions.map((transaction) => transactionId(transaction));
  const header: BlockHeader = {
    version: 1,
    height,
    previousHash: parent.hash,
    timestampSeconds,
    difficulty: parent.header.difficulty,
    merkleRoot: calculateMerkleRoot(height, coinbase, txids),
    powSeed: GENESIS_BLOCK.hash,
    payoutAddress: payout,
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

describe('EdgeX consensus rules', () => {
  test('creates one deterministic genesis with no premine', () => {
    const chain = makeChain();
    expect(GENESIS_BLOCK.coinbase).toBeNull();
    expect(GENESIS_BLOCK.transactions).toHaveLength(0);
    expect(chain.totalIssued).toBe(0n);
    expect(GENESIS_BLOCK.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('accepts a valid mined block and pays exactly the fixed subsidy', () => {
    const chain = makeChain();
    const miner = generateKeyPair();
    const block = buildBlock(chain, addressFromPublicKey(miner.publicKeyHex), GENESIS_BLOCK.header.timestampSeconds + 20);
    expect(chain.addBlock(block)).toBe('extended');
    expect(chain.height).toBe(1);
    expect(chain.totalIssued).toBe(400n * EDX_UNIT);
  });

  test('matures coinbases after six confirmations before allowing a spend', () => {
    const chain = makeChain();
    const miner = generateKeyPair();
    const address = addressFromPublicKey(miner.publicKeyHex);
    let time = GENESIS_BLOCK.header.timestampSeconds;
    const first = buildBlock(chain, address, (time += 15));
    expect(chain.addBlock(first)).toBe('extended');
    for (let height = 2; height <= 7; height += 1) {
      expect(chain.addBlock(buildBlock(chain, address, (time += 15)))).toBe('extended');
    }
    const utxo = chain.stateAt(chain.bestBlockHash).spendable(address, chain.height)[0];
    expect(utxo?.amountPhotons).toBe(400n * EDX_UNIT);

    const fee = 10_000_000n;
    const transfer = signTransaction(
      {
        inputs: [{ txid: utxo!.txid, index: utxo!.index }],
        outputs: [{ address, amount: formatEdxAmount(utxo!.amountPhotons - fee) }],
        fee: formatEdxAmount(fee),
      },
      miner.privateKeyHex,
    );
    const spendBlock = buildBlock(chain, address, (time += 15), [transfer]);
    expect(chain.addBlock(spendBlock)).toBe('extended');
    expect(chain.get(chain.bestBlockHash).state.balance(address)).toBe(3_200n * EDX_UNIT - fee);
  });

  test('keeps an equal-work side chain as a fork', () => {
    const chain = makeChain();
    const minerA = addressFromPublicKey(generateKeyPair().publicKeyHex);
    const minerB = addressFromPublicKey(generateKeyPair().publicKeyHex);
    const canonical = buildBlock(chain, minerA, GENESIS_BLOCK.header.timestampSeconds + 15);
    expect(chain.addBlock(canonical)).toBe('extended');
    const fork = buildBlock(chain, minerB, GENESIS_BLOCK.header.timestampSeconds + 16, [], GENESIS_BLOCK.hash);
    expect(fork.hash).not.toBe(canonical.hash);
    expect(chain.addBlock(fork)).toBe('fork');
    expect(chain.bestBlockHash).toBe(canonical.hash);
  });
});

describe('difficulty and RandomX schedule', () => {
  test('maps difficulty to a bounded target and stable early epochs', () => {
    expect(targetForDifficulty(1n) < 1n << 256n).toBe(true);
    expect(expectedSeedHeight(1)).toBe(0);
    expect(expectedSeedHeight(2049)).toBe(1984);
    expect(nextLwmaDifficulty([])).toBe(1_000_000n);
  });
});

describe('Monero-compatible Stratum blob', () => {
  test('keeps the miner-writable nonce at byte offset 39 in little-endian order', () => {
    const blob = serializeMiningBlob(GENESIS_BLOCK.header, 0x01020304);
    expect(blob[39]).toBe(4);
    expect(blob[40]).toBe(3);
    expect(blob[41]).toBe(2);
    expect(blob[42]).toBe(1);
    expect(readNonce(blob)).toBe(0x01020304);
  });
});
