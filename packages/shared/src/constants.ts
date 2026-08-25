/** Stable network identifiers and protocol limits shared by nodes and wallets. */
export const COIN_NAME = 'EdgeX Network';
export const COIN_SYMBOL = 'EDX';
export const NETWORK_ID = 'edgex-mainnet-rx-edx0-v1';
export const PROTOCOL_VERSION = 1;

/** All on-chain arithmetic uses integer Photons: one EDX is 10^8 Photons. */
export const EDX_DECIMALS = 8;
export const EDX_UNIT = 100_000_000n;
export const TOTAL_SUPPLY = parseAmountLiteral('2100000000');
export const GENESIS_ISSUED = 0n;

function parseAmountLiteral(edx: string): bigint {
  if (!/^\d+$/.test(edx)) throw new Error(`invalid amount literal: ${edx}`);
  return BigInt(edx) * EDX_UNIT;
}

export const TARGET_BLOCK_SECONDS = 15n;
export const LWMA_WINDOW = 240;
export const INITIAL_DIFFICULTY = 1_000_000n;
export const MINIMUM_DIFFICULTY = 1n;
export const TIMESTAMP_FUTURE_TOLERANCE_MS = 120_000;
export const MAX_TIMESTAMP_DROP_MULTIPLIER = 6n;

export const PHASE_1_MAX_HEIGHT = 518_400;
export const PHASE_2_MAX_HEIGHT = 21_024_000;
export const PHASE_1_REWARD = 400n * EDX_UNIT;
export const PHASE_3_REWARD = (3n * EDX_UNIT) / 2n;
export const PHASE_2_DIVISOR = 2n ** 21n;

export const ADDRESS_VERSION = 0x21;
export const ADDRESS_HASH_LENGTH = 20;
export const DERIVATION_PATH = "m/44'/778'/0'/0/0";
export const COINBASE_MATURITY = 6;
export const MAX_TX_INPUTS = 1000;
export const MAX_TX_OUTPUTS = 100;

export const FEE_MEMPOOL_THRESHOLD = 100;
export const FEE_TIERS = {
  slow: '0.01',
  normal: '0.05',
  fast: '0.1',
} as const;

export const RANDOMX_KEY_EPOCH_BLOCKS = 2048;
export const RANDOMX_SEED_DELAY = 64;
export const MINING_NONCE_OFFSET = 39;
export const STRATUM_ALGORITHM = 'rx/0';
export const DEFAULT_PORTS = {
  rpc: 28332,
  p2p: 28333,
  stratum: 3333,
} as const;
