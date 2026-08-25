import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export type MnemonicStrength = 128 | 256;

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(" ");
}

export function generateMnemonicWords(strength: MnemonicStrength = 256): string {
  return generateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(normalizeMnemonic(mnemonic));
}