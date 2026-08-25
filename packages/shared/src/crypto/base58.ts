import { doubleSha256 } from './hash';

export class InvalidBase58Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBase58Error';
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;

  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return '1'.repeat(leadingZeros) + encoded;
}

export function base58Decode(encoded: string): Uint8Array {
  let value = 0n;
  for (const char of encoded) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new InvalidBase58Error(`invalid base58 character: ${char}`);
    value = value * 58n + BigInt(index);
  }

  let leadingZeros = 0;
  while (leadingZeros < encoded.length && encoded[leadingZeros] === '1') leadingZeros += 1;

  const reversed: number[] = [];
  while (value > 0n) {
    reversed.push(Number(value % 256n));
    value /= 256n;
  }
  const result = new Uint8Array(leadingZeros + reversed.length);
  for (let index = 0; index < leadingZeros; index += 1) result[index] = 0;
  reversed.forEach((byte, index) => {
    result[result.length - index - 1] = byte;
  });
  return result;
}

export interface Base58CheckDecoded {
  version: number;
  payload: Uint8Array;
}

export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = doubleSha256(payload).slice(0, 4);
  const full = new Uint8Array(payload.length + checksum.length);
  full.set(payload);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

export function base58CheckDecode(encoded: string): Base58CheckDecoded {
  const full = base58Decode(encoded);
  if (full.length < 5) throw new InvalidBase58Error('base58check payload too short');

  const body = full.slice(0, -4);
  const checksum = full.slice(-4);
  const expected = doubleSha256(body).slice(0, 4);
  for (let index = 0; index < 4; index += 1) {
    if (checksum[index] !== expected[index]) {
      throw new InvalidBase58Error('base58check checksum mismatch');
    }
  }
  return { version: body[0]!, payload: body.slice(1) };
}
