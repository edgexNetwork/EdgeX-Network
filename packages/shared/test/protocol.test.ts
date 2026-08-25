import { describe, expect, test } from 'bun:test';
import {
  EDX_UNIT,
  GENESIS_ISSUED,
  TOTAL_SUPPLY,
  addressFromPublicKey,
  formatEdxAmount,
  generateKeyPair,
  parseEdxAmount,
  phaseRewardAtBoundary,
  rewardForBlock,
  signTransaction,
  transactionId,
  validateAddress,
  validateSignedTransactionShape,
} from '../src';

describe('fair-launch rewards', () => {
  test('genesis has zero issued supply and no coinbase subsidy', () => {
    expect(GENESIS_ISSUED).toBe(0n);
    expect(() => rewardForBlock(0)).toThrow(RangeError);
    expect(rewardForBlock(1)).toBe(400n * EDX_UNIT);
  });

  test('phase two begins with the whitepaper boundary reward', () => {
    const boundary = phaseRewardAtBoundary();
    expect(boundary.height).toBe(518_401);
    expect(boundary.reward).toBe(902n * EDX_UNIT);
  });

  test('supply remains capped and tail emission is exact', () => {
    expect(TOTAL_SUPPLY).toBe(2_100_000_000n * EDX_UNIT);
    expect(rewardForBlock(21_024_001, TOTAL_SUPPLY)).toBe((3n * EDX_UNIT) / 2n);
  });
});

describe('addresses and transactions', () => {
  test('round-trips a compressed public key address', () => {
    const key = generateKeyPair();
    const address = addressFromPublicKey(key.publicKeyHex);
    expect(validateAddress(address)).toBe(true);
  });

  test('signs and derives a deterministic signed transaction id', () => {
    const key = generateKeyPair();
    const unsigned = {
      inputs: [{ txid: 'a'.repeat(64), index: 0 }],
      outputs: [{ address: addressFromPublicKey(key.publicKeyHex), amount: '1.00000000' }],
      fee: '0.01000000',
    };
    const signed = signTransaction(unsigned, key.privateKeyHex);
    const id = transactionId(signed);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(validateSignedTransactionShape(signed)).toBe(101_000_000n);
  });

  test('rejects a modified output', () => {
    const key = generateKeyPair();
    const signed = signTransaction(
      {
        inputs: [{ txid: 'b'.repeat(64), index: 1 }],
        outputs: [{ address: addressFromPublicKey(key.publicKeyHex), amount: '1' }],
        fee: '0.01',
      },
      key.privateKeyHex,
    );
    const mutated = { ...signed, outputs: [{ ...signed.outputs[0]!, amount: '2' }] };
    expect(() => validateSignedTransactionShape(mutated)).toThrow(/signature/);
  });
});

describe('amount encoding', () => {
  test('uses canonical Photon strings', () => {
    expect(parseEdxAmount('1.00000001')).toBe(100_000_001n);
    expect(formatEdxAmount(101_000_000n)).toBe('1.01');
  });

  test('rejects excessive precision', () => {
    expect(() => parseEdxAmount('0.000000001')).toThrow();
  });
});
