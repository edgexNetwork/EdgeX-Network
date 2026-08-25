export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

/** Fixed-width big-endian writer used by the canonical PoW input. */
export class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new EncodingError('u8 out of range');
    }
    this.push(new Uint8Array([value]));
    return this;
  }

  u32(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new EncodingError('u32 out of range');
    }
    const bytes = new Uint8Array(4);
    for (let shift = 24; shift >= 0; shift -= 8) {
      bytes[(24 - shift) / 8] = (value >>> shift) & 0xff;
    }
    this.push(bytes);
    return this;
  }

  /** Monero-compatible fields use little-endian at the miner-visible offset. */
  u32le(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new EncodingError('u32 out of range');
    }
    const bytes = new Uint8Array(4);
    for (let index = 0; index < 4; index += 1) {
      bytes[index] = (value >>> (index * 8)) & 0xff;
    }
    this.push(bytes);
    return this;
  }

  u64(value: bigint): this {
    if (value < 0n || value >= 1n << 64n) throw new EncodingError('u64 out of range');
    const bytes = new Uint8Array(8);
    let remaining = value;
    for (let index = 7; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.push(bytes);
    return this;
  }

  u128(value: bigint): this {
    if (value < 0n || value >= 1n << 128n) throw new EncodingError('u128 out of range');
    const bytes = new Uint8Array(16);
    let remaining = value;
    for (let index = 15; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.push(bytes);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.push(value.slice());
    return this;
  }

  ascii(value: string): this {
    if (value.length > 255) throw new EncodingError('ASCII field too long');
    const bytes = new TextEncoder().encode(value);
    if (bytes.length !== value.length || bytes.some((byte) => byte > 0x7f)) {
      throw new EncodingError('field contains non-ASCII data');
    }
    this.u8(value.length).bytes(bytes);
    return this;
  }

  toBytes(): Uint8Array {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private push(value: Uint8Array): void {
    this.chunks.push(value);
    this.length += value.length;
  }
}
