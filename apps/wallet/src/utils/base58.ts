import {
  base58Decode,
  base58Encode,
  base58CheckDecode as sharedBase58CheckDecode,
  base58CheckEncode as sharedBase58CheckEncode,
  hash160,
  sha256,
} from "@edgex/shared";

export { base58Decode, base58Encode, hash160 };

export function sha256Digest(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export interface Base58CheckDecoded {
  version: number;
  payload: Uint8Array;
}

export function base58CheckEncode(version: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length);
  body[0] = version;
  body.set(payload, 1);
  return sharedBase58CheckEncode(body);
}

export function base58CheckDecode(input: string): Base58CheckDecoded {
  return sharedBase58CheckDecode(input);
}
