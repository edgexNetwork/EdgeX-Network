import { HDKey } from "@scure/bip32";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addressFromPublicKey, signMessage } from "@edgex/shared";
import { ADDRESS_VERSION } from "../utils/constants";
import { base58CheckEncode, hash160 } from "../utils/base58";
import { mnemonicToSeed } from "./mnemonic";

/**
 * HD address derivation and the on-disk address index.
 *
 * Every wallet derives its addresses from one BIP39 mnemonic under the BIP44
 * layout m/44'/778'/0'/{change}/{index} (coin type 778):
 *   - external branch (change = 0): receive addresses, handed out by
 *     getnewaddress / the receive page;
 *   - internal branch (change = 1): change addresses used by external tools.
 *
 * The first external address (index 0) is the wallet's main address and is the
 * identity used everywhere a single address is needed (mining payouts, peer
 * identity, CLI banners).
 *
 * Only the derived index counters are persisted (datadir/wallet.addresses, a
 * small JSON file that never contains keys or the mnemonic). Addresses are
 * re-derived from the mnemonic on demand, so the wallet knows exactly which
 * addresses belong to it without scanning the chain.
 */

/** BIP44 coin type for the EDX chain. */
export const BIP44_COIN_TYPE = 778;

/** Hardened account root below which every wallet address lives. */
export const DERIVATION_ROOT = `m/44'/${BIP44_COIN_TYPE}'/0'`;

/** External (receive) branch. */
export const HD_CHANGE_EXTERNAL = 0;

/** Internal (change) branch. */
export const HD_CHANGE_INTERNAL = 1;

export interface DerivedAddressKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

export interface AddressFileState {
  /** Count of derived external addresses; the next getnewaddress uses this index. */
  nextExternalIndex: number;
  /** Count of derived change addresses; the next getrawchangeaddress uses this index. */
  nextChangeIndex: number;
}

/** Only the main address (external index 0) exists until a new one is derived. */
const DEFAULT_ADDRESS_FILE: AddressFileState = { nextExternalIndex: 1, nextChangeIndex: 1 };

/** Derive the key pair and address at m/44'/778'/0'/{change}/{index}. */
export function deriveAddressAt(mnemonic: string, change: number, index: number): DerivedAddressKey {
  if (change !== HD_CHANGE_EXTERNAL && change !== HD_CHANGE_INTERNAL) {
    throw new RangeError(`invalid change branch: ${change}`);
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`invalid address index: ${index}`);
  }
  const seed = mnemonicToSeed(mnemonic);
  const hd = HDKey.fromMasterSeed(seed).derive(`${DERIVATION_ROOT}/${change}/${index}`);
  const privateKey = hd.privateKey;
  const publicKey = hd.publicKey;
  if (!privateKey || !publicKey) throw new Error("Key derivation failed");
  const address = base58CheckEncode(ADDRESS_VERSION, hash160(publicKey));
  return { privateKey, publicKey, address };
}

/** Derive an external (receive) address: m/44'/778'/0'/0/{index}. */
export function deriveExternalAddress(mnemonic: string, index: number): DerivedAddressKey {
  return deriveAddressAt(mnemonic, HD_CHANGE_EXTERNAL, index);
}

/** Derive an internal (change) address: m/44'/778'/0'/1/{index}. */
export function deriveChangeAddress(mnemonic: string, index: number): DerivedAddressKey {
  return deriveAddressAt(mnemonic, HD_CHANGE_INTERNAL, index);
}

/** Path of the on-disk address index file for a wallet directory. */
export function addressesFilePath(datadir: string): string {
  return path.join(datadir, "wallet.addresses");
}

/** Read the address index; a missing or corrupt file falls back to the default (main address only). */
export function readAddressesFile(datadir: string): AddressFileState {
  const file = addressesFilePath(datadir);
  if (!existsSync(file)) return { ...DEFAULT_ADDRESS_FILE };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AddressFileState>;
    return {
      nextExternalIndex:
        Number.isInteger(parsed.nextExternalIndex) && (parsed.nextExternalIndex as number) >= 0
          ? (parsed.nextExternalIndex as number)
          : DEFAULT_ADDRESS_FILE.nextExternalIndex,
      nextChangeIndex:
        Number.isInteger(parsed.nextChangeIndex) && (parsed.nextChangeIndex as number) >= 0
          ? (parsed.nextChangeIndex as number)
          : DEFAULT_ADDRESS_FILE.nextChangeIndex,
    };
  } catch {
    return { ...DEFAULT_ADDRESS_FILE };
  }
}

/** Persist the address index (0600; only counters, never keys). */
export function writeAddressesFile(datadir: string, state: AddressFileState): void {
  mkdirSync(datadir, { recursive: true });
  writeFileSync(addressesFilePath(datadir), JSON.stringify(state), { mode: 0o600 });
}

/** Derive and persist the next external (receive) address. */
export function nextExternalAddress(datadir: string, mnemonic: string): { address: string; index: number } {
  const state = readAddressesFile(datadir);
  const index = state.nextExternalIndex;
  const derived = deriveExternalAddress(mnemonic, index);
  writeAddressesFile(datadir, { ...state, nextExternalIndex: index + 1 });
  return { address: derived.address, index };
}

/** Derive and persist the next internal (change) address. */
export function nextChangeAddress(datadir: string, mnemonic: string): { address: string; index: number } {
  const state = readAddressesFile(datadir);
  const index = state.nextChangeIndex;
  const derived = deriveChangeAddress(mnemonic, index);
  writeAddressesFile(datadir, { ...state, nextChangeIndex: index + 1 });
  return { address: derived.address, index };
}

/**
 * Every derived wallet address: external indices 0..nextExternalIndex-1 first,
 * then internal indices 0..nextChangeIndex-1. The main address (external 0)
 * is always first.
 */
export function listWalletAddresses(datadir: string, mnemonic: string): string[] {
  const state = readAddressesFile(datadir);
  const addresses: string[] = [];
  for (let index = 0; index < state.nextExternalIndex; index++) {
    addresses.push(deriveExternalAddress(mnemonic, index).address);
  }
  for (let index = 0; index < state.nextChangeIndex; index++) {
    addresses.push(deriveChangeAddress(mnemonic, index).address);
  }
  return addresses;
}

/**
 * Resolve an address back to its derivation branch and index, but only within
 * the already-derived range. Addresses that were never derived are not
 * probed, so foreign addresses always resolve to null.
 */
export function findAddressIndex(
  datadir: string,
  mnemonic: string,
  address: string,
): { change: number; index: number } | null {
  const state = readAddressesFile(datadir);
  const probe = (change: number, count: number): { change: number; index: number } | null => {
    for (let index = 0; index < count; index++) {
      const derived =
        change === HD_CHANGE_EXTERNAL
          ? deriveExternalAddress(mnemonic, index)
          : deriveChangeAddress(mnemonic, index);
      if (derived.address === address) return { change, index };
    }
    return null;
  };
  return probe(HD_CHANGE_EXTERNAL, state.nextExternalIndex)
    ?? probe(HD_CHANGE_INTERNAL, state.nextChangeIndex);
}

/** Private key hex for one of the wallet's derived addresses (throws when the address is not in the wallet). */
export function privateKeyHexForAddress(datadir: string, mnemonic: string, address: string): string {
  const found = findAddressIndex(datadir, mnemonic, address);
  if (!found) throw new Error(`Address is not in this wallet: ${address}`);
  const derived =
    found.change === HD_CHANGE_EXTERNAL
      ? deriveExternalAddress(mnemonic, found.index)
      : deriveChangeAddress(mnemonic, found.index);
  return Buffer.from(derived.privateKey).toString("hex");
}

/** Compressed public key hex for one of the wallet's derived addresses (throws when not in the wallet). */
export function publicKeyHexForAddress(datadir: string, mnemonic: string, address: string): string {
  const found = findAddressIndex(datadir, mnemonic, address);
  if (!found) throw new Error(`Address is not in this wallet: ${address}`);
  const derived =
    found.change === HD_CHANGE_EXTERNAL
      ? deriveExternalAddress(mnemonic, found.index)
      : deriveChangeAddress(mnemonic, found.index);
  return Buffer.from(derived.publicKey).toString("hex");
}

/** Sign an arbitrary message with the key of one of the wallet's derived addresses. */
export function signForAddress(datadir: string, mnemonic: string, address: string, message: string): string {
  return signMessage(privateKeyHexForAddress(datadir, mnemonic, address), message);
}

// Re-exported for callers that build addresses from a compressed public key.
export { addressFromPublicKey };
