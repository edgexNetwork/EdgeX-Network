import {
  COINBASE_MATURITY,
  GENESIS_ISSUED,
  STRATUM_ALGORITHM,
  validateAddress,
  formatEdxAmount,
  parseEdxAmount,
  rewardForBlock,
  sha256Hex,
  transactionId,
  addressFromPublicKey,
} from '@edgex/shared';
import type { SignedTransaction } from '@edgex/shared';
import {
  ConsensusChain,
  calculateMerkleRoot,
  coinbaseId,
  createGenesisBlock,
  GENESIS_HASH,
  serializeMiningBlob,
  targetForDifficulty,
  workForDifficulty,
} from '@edgex/core';
import type { Block, PowVerifier } from '@edgex/core';
import { BlockchainStore } from './storage';
import { TransactionMempool } from './mempool';
import type { NodeConfig } from './config';

export interface MiningJob {
  jobId: string;
  blobHex: string;
  seedHash: string;
  targetHex: string;
  height: number;
  difficulty: bigint;
  block: Block;
}

export interface SubmittedShare {
  result: 'extended' | 'fork' | 'known';
  block: Block;
}

export interface TransactionHistoryItem {
  txid: string;
  type: 'transfer' | 'mining';
  category: 'send' | 'receive';
  amount: string;
  fee: string;
  status: 'pending' | 'confirmed';
  confirmations: number;
  matureAtHeight: number | null;
  height: number | null;
  time: number;
  from: string | null;
  inputs: Array<{ txid: string; index: number; address: string; amount: string }>;
  outputs: Array<{ address: string; amount: string; isChange: boolean }>;
}

export class ChainService {
  readonly chain: ConsensusChain;
  readonly mempool = new TransactionMempool();
  onTransactionAccepted?: ((transaction: SignedTransaction) => void) | undefined;
  onBlockAccepted?: ((block: Block) => void) | undefined;
  peerStatus?: (() => { connected: number; total: number }) | undefined;
  private jobs = new Map<string, MiningJob>();

  constructor(
    verifier: PowVerifier,
    private readonly store: BlockchainStore,
    private readonly networkId: string,
  ) {
    this.chain = new ConsensusChain(verifier);
    if (this.store.count() === 0) {
      const genesis = createGenesisBlock();
      this.store.saveBlock(genesis, workForDifficulty(genesis.header.difficulty));
    }
    this.loadPersistedBlocks();
  }

  info() {
    return {
      networkId: this.networkId,
      genesisHash: GENESIS_HASH,
      height: this.chain.height,
      bestHash: this.chain.bestBlockHash,
      totalIssued: formatEdxAmount(this.chain.totalIssued),
      mempoolSize: this.mempool.size,
      lastBlockTime: this.chain.get(this.chain.bestBlockHash).block.header.timestampSeconds,
    };
  }

  canonicalBlocks(startHeightValue: number, limitValue: number): Block[] {
    const startHeight = Math.max(0, Math.trunc(Number.isFinite(startHeightValue) ? startHeightValue : 0));
    const limit = Math.max(1, Math.min(Number.isFinite(limitValue) ? limitValue : 200, 500));
    const result: Block[] = [];
    let hash = this.chain.bestBlockHash;
    while (result.length < limit) {
      const block = this.chain.get(hash).block;
      if (block.header.height < startHeight) break;
      result.push(block);
      if (block.header.height === 0) break;
      hash = block.header.previousHash;
    }
    return result.reverse();
  }

  acceptTransaction(transaction: SignedTransaction): string {
    const id = transactionId(transaction);
    if (this.mempool.has(id)) return id;
    const acceptedId = this.mempool.accept(transaction, this.chain.stateAt(this.chain.bestBlockHash), this.chain.height);
    this.onTransactionAccepted?.(transaction);
    return acceptedId;
  }

  acceptBlock(block: Block): 'extended' | 'fork' | 'known' {
    const result = this.chain.addBlock(block);
    this.store.saveBlock(block, this.chain.get(block.hash).totalWork);
    const committedIds = block.transactions.map((transaction) => transactionId(transaction));
    this.mempool.removeCommitted(committedIds);
    if (result === 'extended') this.onBlockAccepted?.(block);
    return result;
  }

  createJob(payoutAddress: string): MiningJob {
    if (!validateAddress(payoutAddress)) throw new Error('invalid payout address');
    const next = this.chain.nextConsensusData();
    const subsidy = rewardForBlock(next.height, this.chain.totalIssued);
    const entries = this.mempool.list();
    const transactions = entries.map((entry) => entry.transaction);
    const txids = transactions.map((transaction) => transactionId(transaction));
    const coinbase = { outputs: [{ address: payoutAddress, amount: formatEdxAmount(subsidy) }] };
    const header = {
      version: 1,
      height: next.height,
      previousHash: this.chain.bestBlockHash,
      timestampSeconds: Math.floor(Date.now() / 1000),
      difficulty: next.difficulty,
      merkleRoot: calculateMerkleRoot(next.height, coinbase, txids),
      powSeed: next.powSeed,
      payoutAddress,
    };
    const nonce = 0;
    const jobId = sha256Hex(new TextEncoder().encode(`${this.networkId}:${header.previousHash}:${next.height}:${Date.now()}`));
    const job: MiningJob = {
      jobId,
      blobHex: bytesToHex(serializeMiningBlob(header, nonce)),
      seedHash: next.powSeed,
      targetHex: littleEndianTarget(targetForDifficulty(next.difficulty)),
      height: next.height,
      difficulty: next.difficulty,
      block: {
        header,
        hash: '',
        nonce,
        coinbase,
        transactions,
      },
    };
    this.jobs.clear();
    this.jobs.set(jobId, job);
    return job;
  }

  job(id: string): MiningJob | undefined {
    return this.jobs.get(id);
  }

  submitShare(jobId: string, nonceHex: string, hashHex: string): SubmittedShare {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown mining job');
    if (!/^[\da-f]{8}$/i.test(nonceHex)) throw new Error('invalid nonce encoding');
    if (!/^[\da-f]{64}$/i.test(hashHex)) throw new Error('invalid proof-of-work hash');

    // Stratum carries the four nonce bytes exactly as they appeared in the blob.
    let nonce = 0;
    for (let index = 6; index >= 0; index -= 2) {
      nonce = (nonce << 8) | Number.parseInt(nonceHex.slice(index, index + 2), 16);
    }
    const candidate: Block = {
      ...job.block,
      nonce,
      hash: hashHex.toLowerCase(),
    };
    const result = this.acceptBlock(candidate);
    return { result, block: candidate };
  }

  private loadPersistedBlocks(): void {
    const rows = this.store.allBlocksByHeight();
    for (const row of rows) {
      try {
        this.chain.addBlock(row.block);
      } catch {
        // A corrupt or foreign side-chain row must not prevent startup.
      }
    }
  }

  history(address: string, limitValue: number): TransactionHistoryItem[] {
    if (!validateAddress(address)) throw new Error('invalid address');
    const limit = Math.max(1, Math.min(Number.isFinite(limitValue) ? limitValue : 20, 10_000));
    const confirmed: TransactionHistoryItem[] = [];
    let hash = this.chain.bestBlockHash;
    let block = this.chain.get(hash).block;
    while (block.header.height > 0 && confirmed.length < limit) {
      const parentState = this.chain.stateAt(block.header.previousHash);
      const coinbase = block.coinbase;
      const coinbaseOutput = coinbase?.outputs[0];
      if (coinbase && coinbaseOutput?.address === address) {
        confirmed.push(this.coinbaseItem(block, coinbaseOutput));
        if (confirmed.length >= limit) break;
      }
      for (const transaction of block.transactions) {
        const sender = addressFromPublicKey(transaction.pubkey);
        const receives = transaction.outputs.some((output) => output.address === address);
        if (sender !== address && !receives) continue;
        confirmed.push(this.transactionItem(block, parentState, transaction, sender, address));
        if (confirmed.length >= limit) break;
      }
      hash = block.header.previousHash;
      block = this.chain.get(hash).block;
    }

    // Preserve the wallet's legacy behavior: pending submissions precede
    // confirmed records until a mined block removes them from the mempool.
    const tipState = this.chain.stateAt(this.chain.bestBlockHash);
    const remaining = limit - confirmed.length;
    const pending = this.mempool.list(remaining).flatMap((entry): TransactionHistoryItem[] => {
      const sender = addressFromPublicKey(entry.transaction.pubkey);
      const receives = entry.transaction.outputs.some((output) => output.address === address);
      if (sender !== address && !receives) return [];
      return [{
        ...this.transactionItem(
          this.chain.get(this.chain.bestBlockHash).block,
          tipState,
          entry.transaction,
          sender,
          address,
        ),
        status: 'pending',
        confirmations: 0,
        height: null,
        time: Math.floor(entry.receivedAtMs / 1000),
      }];
    });
    return [...pending, ...confirmed].slice(0, limit);
  }

  findTransaction(txid: string): TransactionHistoryItem | null {
    if (!/^[\da-f]{64}$/i.test(txid)) return null;
    let hash = this.chain.bestBlockHash;
    let block = this.chain.get(hash).block;
    while (block.header.height >= 0) {
      const parentState = block.header.height > 0 ? this.chain.stateAt(block.header.previousHash) : this.chain.stateAt(this.chain.bestBlockHash);
      if (block.coinbase && coinbaseId(block.header.height, block.coinbase) === txid.toLowerCase()) {
        return this.coinbaseItem(block, block.coinbase.outputs[0]!);
      }
      const transaction = block.transactions.find((candidate) => transactionId(candidate) === txid.toLowerCase());
      if (transaction) {
        return this.transactionItem(block, parentState, transaction, addressFromPublicKey(transaction.pubkey), addressFromPublicKey(transaction.pubkey));
      }
      if (block.header.height === 0) break;
      hash = block.header.previousHash;
      block = this.chain.get(hash).block;
    }
    return null;
  }

  private coinbaseItem(block: import('@edgex/core').Block, output: { address: string; amount: string }): TransactionHistoryItem {
    return {
      txid: coinbaseId(block.header.height, block.coinbase!),
      type: 'mining',
      category: 'receive',
      amount: output.amount,
      fee: '0',
      status: 'confirmed',
      confirmations: this.chain.height - block.header.height + 1,
      matureAtHeight: block.header.height + COINBASE_MATURITY,
      height: block.header.height,
      time: block.header.timestampSeconds,
      from: null,
      inputs: [],
      outputs: [{ ...output, isChange: false }],
    };
  }

  private transactionItem(
    block: import('@edgex/core').Block,
    parentState: import('@edgex/core').UtxoState,
    transaction: SignedTransaction,
    sender: string,
    queriedAddress: string,
  ): TransactionHistoryItem {
    const id = transactionId(transaction);
    const category = sender === queriedAddress ? 'send' : 'receive';
    const relevantOutputs = transaction.outputs.filter((output) => output.address === queriedAddress);
    const amount = category === 'send'
      ? transaction.outputs
          .filter((output) => output.address !== sender)
          .reduce((total, output) => total + parseEdxAmount(output.amount), 0n)
      : relevantOutputs.reduce((total, output) => total + parseEdxAmount(output.amount), 0n);
    return {
      txid: id,
      type: 'transfer',
      category,
      amount: formatEdxAmount(amount),
      fee: transaction.fee,
      status: 'confirmed',
      confirmations: this.chain.height - block.header.height + 1,
      matureAtHeight: null,
      height: block.header.height,
      time: block.header.timestampSeconds,
      from: sender === queriedAddress ? null : sender,
      inputs: transaction.inputs.map((input) => {
        const entry = parentState.get(`${input.txid}:${input.index}`);
        return {
          txid: input.txid,
          index: input.index,
          address: entry?.address ?? '',
          amount: entry ? formatEdxAmount(entry.amountPhotons) : '0',
        };
      }),
      outputs: transaction.outputs.map((output) => ({
        address: output.address,
        amount: output.amount,
        isChange: category === 'send' && output.address === sender,
      })),
    };
  }

  peers(): { connected: number; total: number; items: Array<{ id: number; address: string; connected: boolean; latencyMs: number | null; source: string }> } {
    const status = this.peerStatus?.() ?? { connected: 0, total: 0 };
    return {
      connected: status.connected,
      total: status.total,
      items: [{
        id: 1,
        address: 'local-full-node',
        connected: true,
        latencyMs: null,
        source: 'self',
      }],
    };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function littleEndianTarget(target: bigint): string {
  const bytes = new Uint8Array(32);
  let value = target;
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  // Send the conventional 64-bit Monero Stratum threshold derived from full target.
  return bytesToHex(bytes.slice(24));
}

export const INITIAL_NETWORK_SUPPLY = GENESIS_ISSUED;
