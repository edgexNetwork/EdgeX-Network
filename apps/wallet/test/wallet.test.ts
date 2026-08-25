import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAddress, validateSignedTransactionShape } from '@edgex/shared';
import { createWalletKey, planTransaction, signPlannedTransaction, walletFromMnemonic } from '../src/wallet';
import { loadWalletVault, saveWalletVault } from '../src/vault';

const directory = mkdtempSync(join(tmpdir(), 'edgex-wallet-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('local wallet keys', () => {
  test('derives the documented BIP44 path without network access', () => {
    const key = createWalletKey();
    expect(key.mnemonic.split(' ')).toHaveLength(24);
    expect(validateAddress(key.address)).toBe(true);
    expect(walletFromMnemonic(key.mnemonic).address).toBe(key.address);
  });

  test('encrypts and decrypts only with the local password', () => {
    const key = createWalletKey();
    const path = join(directory, 'wallet.vault');
    saveWalletVault(path, key, 'correct horse battery');
    expect(loadWalletVault(path, 'correct horse battery').address).toBe(key.address);
    expect(() => loadWalletVault(path, 'wrong password')).toThrow(/wrong wallet password/);
  });
});

describe('transaction planning', () => {
  test('selects oldest-first UTXOs and returns signed change', () => {
    const sender = createWalletKey();
    const recipient = createWalletKey().address;
    const planned = planTransaction(
      [
        { txid: '1'.repeat(64), index: 0, amount: '100.00000000', birthHeight: 10 },
        { txid: '2'.repeat(64), index: 0, amount: '50.00000000', birthHeight: 2 },
      ],
      recipient,
      sender.address,
      '120.00000000',
      '0.01000000',
    );
    expect(planned.unsigned.inputs.map((input) => input.txid)).toEqual(['2'.repeat(64), '1'.repeat(64)]);
    expect(planned.change).toBe(2_999_000_000n);
    const signed = signPlannedTransaction(planned, sender);
    expect(validateSignedTransactionShape(signed)).toBe(15_000_000_000n);
    expect(signed.outputs[0]?.address).toBe(recipient);
    expect(signed.outputs[1]?.address).toBe(sender.address);
  });
});
