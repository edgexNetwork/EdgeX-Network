# Offline Transaction Signing Demo

This demo shows how to build, sign and broadcast an EDX transaction **without the
wallet ever touching the private key**. Everything key-related happens in this
script: it generates (or accepts) a BIP39 mnemonic, derives the EDX address,
builds the signing message, and produces the secp256k1 signature. The only
output the caller needs is the **broadcastable hex value** of the signed
transaction, which can be handed to any node.

It is a reference implementation: the message format, hash, signature and
transaction id derivations below are the exact consensus rules any EDX wallet or
node must agree on.

## The signing scheme (protocol specification)

A transaction has three parts, all expressed as decimal strings with up to 8
decimals (the "EDX" unit; 1 EDX = 100,000,000 Photons):

- `inputs`: an ordered list of `{ txid, index }` — each spends the output at
  `index` of the transaction `txid`.
- `outputs`: an ordered list of `{ address, amount }`.
- `fee`: a single decimal string.

### 1. The signing message

Build a UTF-8 text message from the transaction, one line per element, joined
with `\n` (newline, U+000A):

```
input:{i}:{txid}:{index}
...
fee:{fee}
{j}:{address}:{amount}
...
```

- One `input:` line per input, numbered `i = 0, 1, 2, ...` in input order.
- A single `fee:` line.
- One output line per output, numbered `j = 0, 1, 2, ...` in output order.
  Each line is `{j}:{address}:{amount}` (no prefix).

Example (1 input, 2 outputs):

```
input:0:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:0
fee:0.00010000
0:Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f:10.00000000
1:Ea455DTrfM5CZ1kFfg8Jgntp8Qbx8kjt7f:89.99990000
```

### 2. The digest

`digest = SHA-256(message)` — a **single** SHA-256 over the UTF-8 bytes of the
message text. There is no double hashing and no prefix.

### 3. The signature

`signature = ECDSA-SECP256K1(privateKey, digest)` using the compact (r || s)
encoding: 32-byte r followed by 32-byte s, 64 bytes total, serialized as a
128-character lowercase hex string. The public key must be the **compressed**
33-byte form (starts with `02` or `03`).

### 4. The transaction id

`txid = SHA-256(message + "\n" + signature)` — the message text, a newline, then
the 128-hex signature, hashed once with SHA-256. The result is the 64-character
hex transaction id.

### 5. The address

`address = Base58Check(0x21 || RIPEMD160(SHA-256(compressedPublicKey)))` — the
version byte is `0x21`, the payload is the 20-byte hash160 of the compressed
public key, and the Base58Check checksum is the first 4 bytes of
SHA-256(SHA-256(payload)). Valid EDX addresses start with `E`.

## The broadcastable value

The demo prints a single hex string: `hex(UTF-8 JSON)` of the signed
transaction body:

```json
{
  "inputs":  [ { "txid": "...", "index": 0 } ],
  "outputs": [ { "address": "...", "amount": "10.00000000" },
               { "address": "...", "amount": "89.99990000" } ],
  "fee":     "0.00010000",
  "pubkey":  "02...",   // 66 hex chars, compressed public key
  "signature": "..."    // 128 hex chars, r || s
}
```

Send this value to a node's `POST /transactions` endpoint (the body is the JSON
above) or to a wallet RPC `sendrawtransaction` with the hex string. The node
recomputes `transactionId(signed)` and validates the signature against `pubkey`
before accepting it into the mempool.

## Running the demo

```bash
# From the repository root
bun demo/offline-sign/offline-sign.ts --mnemonic "abandon abandon ... about"
# Or let it generate a fresh mnemonic and print it
bun demo/offline-sign/offline-sign.ts
```

Options (all optional):

| Flag | Meaning |
| --- | --- |
| `--mnemonic=<words>` | Use this BIP39 mnemonic instead of generating a new one. |
| `--utxo-txid=<hex>` | The funding transaction id to spend. |
| `--utxo-index=<n>` | The output index to spend (default 0). |
| `--utxo-amount=<EDX>` | The confirmed amount at that output. |
| `--to=<address>` | The recipient address (default: the derived address itself). |
| `--amount=<EDX>` | How much to send to `--to` (default: half of the UTXO). |
| `--fee=<EDX>` | The transaction fee (default `0.00010000`). |

When no UTXO is supplied the demo runs in **template mode**: it prints the
signing message format with placeholder inputs and a single 0.01 EDX output, so
you can inspect the exact UTF-8 text that gets hashed. Supply a real UTXO
(`--utxo-txid`, `--utxo-amount`, plus optional `--amount`/`--to`/`--fee`) to get
a signed, broadcastable value.

## What it prints

1. The mnemonic (for the wallet recovery; treat it as secret).
2. The derived EDX address.
3. The signing message (exactly the UTF-8 text that is hashed).
4. The SHA-256 digest.
5. The 128-hex signature.
6. The transaction id (`SHA-256(message + "\n" + signature)`).
7. The broadcastable hex value (hex of UTF-8 JSON, ready for `sendrawtransaction`
   or `POST /transactions`).
