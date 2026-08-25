import { dlopen, ptr, suffix, FFIType } from 'bun:ffi';
import { hashMeetsTarget } from '@edgex/core';
import type { PowVerifier } from '@edgex/core';

type RandomXFunction = (...args: any[]) => any;

interface RandomXSymbols {
  randomx_get_flags: RandomXFunction;
  randomx_alloc_cache: RandomXFunction;
  randomx_init_cache: RandomXFunction;
  randomx_create_vm: RandomXFunction;
  randomx_calculate_hash: RandomXFunction;
}

interface RandomXLibrary {
  symbols: RandomXSymbols;
  close(): void;
}

const RANDOMX_FLAG_FULL_MEM = 1n << 1n;

function defaultLibraryPath(): string {
  if (process.platform === 'win32') return 'vendor/RandomX/build/Release/randomx.dll';
  return `vendor/RandomX/build/librandomx.${suffix}`;
}

/**
 * Bind the unchanged upstream RandomX C ABI in light-verification mode.
 * EdgeX changes the input and key schedule, never RandomX instructions.
 */
export class NativeRandomXVerifier implements PowVerifier {
  private readonly library: RandomXLibrary;
  private readonly caches = new Map<string, number>();
  private readonly virtualMachines = new Map<string, number>();

  constructor(libraryPath = process.env.EDX_RANDOMX_LIBRARY ?? defaultLibraryPath()) {
    this.library = dlopen(libraryPath, {
      randomx_get_flags: { args: [], returns: FFIType.u32 },
      randomx_alloc_cache: { args: [FFIType.u32], returns: FFIType.ptr },
      randomx_init_cache: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
      randomx_create_vm: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      randomx_calculate_hash: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    }) as unknown as RandomXLibrary;
    if (this.library.symbols.randomx_get_flags() === 0) throw new Error('RandomX returned no supported flags');
  }

  verify(miningBlob: Uint8Array, claimedHashHex: string, difficulty: bigint): boolean {
    if (!/^[0-9a-f]{64}$/.test(claimedHashHex)) return false;
    const seedHex = bytesToHex(miningBlob.slice(95, 127));
    const output = Buffer.alloc(32);
    const virtualMachine = this.virtualMachineForSeed(seedHex);
    this.library.symbols.randomx_calculate_hash(virtualMachine, ptr(miningBlob), miningBlob.length, ptr(output));
    let actual = '';
    for (const byte of output) actual += byte.toString(16).padStart(2, '0');
    return actual === claimedHashHex && hashMeetsTarget(actual, difficulty);
  }

  private virtualMachineForSeed(seedHex: string): number {
    const existing = this.virtualMachines.get(seedHex);
    if (existing !== undefined) return existing;

    let flags = BigInt(this.library.symbols.randomx_get_flags());
    flags &= ~RANDOMX_FLAG_FULL_MEM;
    const numericFlags = Number(flags & 0xffffffffn);
    const key = Buffer.from(seedHex, 'hex');
    const cache = this.library.symbols.randomx_alloc_cache(numericFlags) as number;
    if (!cache) throw new Error('unable to allocate RandomX cache');
    this.library.symbols.randomx_init_cache(cache, ptr(key), key.length);
    const virtualMachine = this.library.symbols.randomx_create_vm(numericFlags, cache, null) as number;
    if (!virtualMachine) throw new Error('unable to create RandomX verification VM');
    this.caches.set(seedHex, cache);
    this.virtualMachines.set(seedHex, virtualMachine);
    return virtualMachine;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
