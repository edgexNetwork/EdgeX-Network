# EdgeX Decentralized Node

EdgeX is a CPU-mined UTXO blockchain built around Nakamoto consensus and the
upstream RandomX virtual machine. The chain uses an EdgeX-specific block layout,
key schedule, genesis, and reward rules, while exposing a Monero-compatible
Stratum job surface so most existing RandomX mining clients can connect without
changing the RandomX core.

## Security model

- No administrator endpoints, no centralized ledger writer, and no premine.
- The genesis block has zero supply; all coins come from validated coinbases.
- Wallet signing is local, and nodes only receive signed transactions.
- No telemetry, device fingerprinting, password reporting, file scanning, or
  remote asset synchronization exists in this repository.
- Peer messages are validated with the same consensus rules as local blocks.

## Consensus profile

The PoW is `rx/edx0`: upstream RandomX remains byte-for-byte unchanged, but its
input is the canonical EdgeX header described below and its key is selected by
the EdgeX delayed epoch schedule.

- Deterministic zero-supply genesis.
- 15 second target and 240-block LWMA difficulty adjustment.
- 2048-block RandomX key epochs with a 64-block seed lookahead delay.
- Six-confirmation coinbase maturity.
- Explicit signed UTXO inputs; transaction fees are burned rather than paid to
  the miner, matching the whitepaper emission policy.
- The canonical mining blob places the nonce at offset `39`, matching the Monero
  Stratum client convention.

## Peer links and fragmented sends

A wallet treats every configured full node as a peer. It probes direct RPC and a
binary-safe `ws://host:port/p2p` link, uses whichever path is available, retries
the other peer on failure, and remembers runtime-added peers in
`<datadir>/peers.json`. The P2P RPC surface is rate-limited and exposes the same
validation rules as loopback RPC; there is no centralized relay or traffic
obfuscation layer.

Transfers use oldest-first coin selection. When a payment would exceed 950
inputs (`MAX_TX_INPUTS` minus safety margin), the planner creates multiple valid
transactions: intermediate transactions sweep that batch toward the recipient,
and the final transaction pays the remainder plus change. Each transaction pays
the configured fee independently.

## Repository layout

`packages/shared` contains deterministic protocol primitives used by both the
node and wallet. `packages/core` contains consensus validation. `apps/node`
contains the peer-to-peer node, JSON RPC, Stratum server, storage, and native
RandomX binding boundary. `apps/wallet` contains local key management, signing,
and a thin node client.

## Wallet TUI

The wallet reproduces the legacy seven-view interface: balance, send, receive,
history, network, fees, and logs. It supports the mouse UI mode and the command
mode (`Ctrl+B`), interactive dialogs, QR receive view, clipboard actions, SGR
mouse events, scrolling, command history, and onboarding for create/import.

The interface supports Simplified Chinese, English, Russian, and Japanese. Use
`Ctrl+L`, the top-bar language button, or the `lang [zh|en|ru|ja]` command.
Manual language and UI-mode selections are stored locally in
the machine-wide encrypted global database (`~/.edgex-decentralized/global.db`).
Legacy `ui-state.json` values are migrated read-only when present.

## Wallet data

Wallet creation writes a binary encrypted `wallet.vault`. Starting the wallet
also creates `<datadir>/chain.db`, an AES-256-GCM-encrypted SQLite database
whose key is derived from that wallet's private key. It caches canonical blocks,
transaction/output indexes, addresses, and maturity state. Copying `chain.db`
to another wallet fails authentication. A separate encrypted global database
stores only UI preferences and schema metadata; it contains no device
fingerprint, password queue, personal-file ledger, or telemetry.

## Development commands

```bash
bun install
bun test
bun run typecheck
bun run apps/node/src/index.ts start
bun run apps/wallet/src/index.tsx
```

Build RandomX from the checked-out submodule before enabling native verification:

```bash
cmake -S vendor/RandomX -B vendor/RandomX/build -DBUILD_SHARED_LIBS=ON
cmake --build vendor/RandomX/build --config Release
```

Without the library, tests use explicit fake hashers; production nodes reject
startup unless a real RandomX verifier is supplied or native mode is enabled.
