# EdgeX Network — Technical Whitepaper

**Version**: v1.0.0

**Positioning**: Edge-Native Proof-of-Work Infrastructure

**Ticker**: EDX (smallest atomic unit: Photon)

---

## Abstract

Bitcoin opened the era of decentralized peer-to-peer electronic cash. Fifteen years later, PoW in practice looks nothing like its original promise: purpose-built ASICs own most of the global hashrate, and full-node clients keep growing heavier. Modern mining has quietly turned into a game played by a handful of industrial datacenters.

EdgeX Network proposes an edge-native proof-of-work architecture. It pairs the ASIC-resistant **RandomX** algorithm with the **Bun / TypeScript** async runtime — a combination that democratizes both ends of the stack:

1. **Hardware**: hashing power flows back to home CPUs, NAS boxes, Raspberry Pis and other small edge devices;
2. **Software**: thanks to Bun FFI, a full node is just a lightweight scripted application that boots in milliseconds and barely touches memory;
3. **DePIN**: while securing consensus, every node doubles as an edge service provider, serving decentralized RPC and data caching over Bun's high-concurrency runtime.

---

## 1. Background and the Problem

PoW has drifted away from the "one CPU, one vote" ideal. Three layers of centralization stand in the way:

* **ASIC centralization.** Custom silicon built exponential efficiency advantages on SHA-256, Scrypt and similar algorithms. Ordinary personal devices simply cannot compete anymore, and global hashrate concentrates into a few large pools and industrial-scale farms.
* **Client bloat.** Mainstream clients such as Geth or Bitcoin Core lean on heavy C++/Rust toolchains. Memory footprints are large, initial sync takes days, and as a result the share of users running a full node keeps shrinking.
* **A divided developer ecosystem.** Over 65% of developers worldwide work in JavaScript/TypeScript, yet PoW internals remain walled off from them. That gap slows down application-layer innovation and keeps the ecosystem from spreading.

---

## 2. Architecture

EdgeX splits responsibilities cleanly: a C++ compute kernel at the bottom, an async TypeScript layer on top. Consensus math stays out of the way of network business logic.

```
+-------------------------------------------------------------+
|                  EdgeX Application & DePIN API              |
|          (Web3 RPC, Fast JSON-RPC, Edge Data Caching)       |
+-------------------------------------------------------------+
|               Bun Runtime / TypeScript Engine               |
|  - P2P Gossip Network (TCP/WebSocket)                       |
|  - Transaction Pool (Mempool) & Validation Pipeline         |
|  - Embedded State Storage (SQLite / Key-Value Engine)       |
+-------------------------------------------------------------+
|             Foreign Function Interface (Bun Native FFI)     |
+-------------------------------------------------------------+
|                RandomX Native C++ Kernel                    |
|      - CPU JIT Compiler  - Light/Fast Scratchpad (2GB+)     |
+-------------------------------------------------------------+
```

### 2.1 Bridging RandomX through Bun Native FFI

RandomX leans hard on randomized memory access (the scratchpad) and CPU JIT compilation. EdgeX binds the C++ shared library through **Bun Native FFI** with zero-copy semantics:

* **Compute isolation.** Hashing and block validation run inside a dedicated C++ thread pool, so the main event loop never stalls.
* **Near-zero overhead.** TypeScript reads hash results directly through pointers; the cost of crossing the boundary is negligible.

### 2.2 Micro-Node Engine

There is no external database server to install. State lives inside the node itself:

* Bun ships with a native SQLite driver. Combined with an LSM-Tree layout, this gives nanosecond-level index reads and a ledger small enough to fit on any edge device.
* One command gets a node running. Cold start is measured in milliseconds:

```bash
bunx create-edgex-node --start
```

### 2.3 Edge Compute & RPC Grid

Bun handles HTTP and WebSocket traffic at very high throughput out of the box, which means an EdgeX node does more than keep accounts:

* **Consensus income.** CPUs compete for blocks under RandomX and earn EDX rewards.
* **Service income.** Nodes can open low-latency RPC endpoints and caching services to the public — a decentralized physical infrastructure network in the literal sense.

---

## 3. Consensus and Network Parameters

Parameters are tuned for high throughput without punishing nodes on residential connections:

| Parameter | Value | Rationale |
| --- | --- | --- |
| **Algorithm** | RandomX (CPU-optimized) | Hard memory dependency rules out ASICs and large GPU rigs |
| **Block time** | **15 seconds** | Plays to Bun's async I/O strengths; settlement feels close to Web2 latency |
| **Difficulty retarget** | **LWMA** (linearly weighted moving average) | 240-block window (~1 hour); smooths hashrate swings and blunts sudden-difficulty attacks |
| **Precision** | **8 decimals** | $1 \text{ EDX} = 10^8 \text{ Photons}$; maps cleanly onto native `BigInt` with no overflow risk |
| **Transport** | TCP + WebSocket | Protocol-level tuning for NAT traversal and chatty edge devices |

---

## 4. Tokenomics and Emission

EdgeX follows a strict **100% fair launch** — **zero premine**. Every EDX in existence comes out of CPU work.

### 4.1 Base Parameters

* **Name**: EdgeX Network
* **Ticker**: EDX
* **Hard cap**: **2,100,000,000 EDX** (2.1 billion)
* **Smallest unit**: **Photon**, where $1 \text{ Photon} = 0.00000001 \text{ EDX}$

### 4.2 A Three-Phase Emission Curve

```
[Phase 1: Bootstrap] ---------> [Phase 2: Smooth Decay] ---------> [Phase 3: Tail Emission]
   (days 1–90)                    (day 91 – year 10)                 (after year 10)
```

#### Phase 1 — Bootstrap Era (days 1–90)

Cold start needs hashrate, so early blocks pay well. The goal is simple: pull idle CPUs, NAS units and microservers from around the world into the network during the first 90 days.

* **Height range**: $H \in [1,\ 518400]$ (roughly 90 days at 5,760 blocks/day)
* **Fixed reward**: **400 EDX per block**
* **Phase total**: $207{,}360{,}000$ EDX (~9.87% of supply)

#### Phase 2 — Smooth Decay Era (day 91 → year 10)

Bitcoin-style halvings create cliff effects: miners switch off overnight when margins flip negative. EdgeX avoids the cliff with a continuous decay formula instead:

$$\text{Reward}(H) = \frac{\text{Remaining}(H)}{21 \times 10^9}$$

where $\text{Remaining}(H)$ is the unmined base supply left at height $H$.

**Projected emission schedule:**

| Milestone | Height range | Reward per block | Phase output | Cumulative supply |
| --- | --- | --- | --- | --- |
| **Days 1–90 (bootstrap)** | $1 - 518{,}400$ | **400.0 EDX** | ~207M EDX | 9.87% |
| **Year 1 (remainder)** | $518{,}401 - 2{,}102{,}400$ | **~280.0 EDX** | ~443M EDX | 30.95% |
| **Year 2** | $2{,}102{,}401 - 4{,}204{,}800$ | **~190.0 EDX** | ~399M EDX | 50.00% |
| **Year 3** | $4{,}204{,}801 - 6{,}307{,}200$ | **~130.0 EDX** | ~273M EDX | 63.00% |
| **Year 4** | $6{,}307{,}201 - 8{,}409{,}600$ | **~90.0 EDX** | ~189M EDX | 72.00% |
| **Years 5–10** | $8{,}409{,}601 - 21{,}024{,}000$ | **decaying to ~5.0 EDX** | ~588M EDX | **~100.00%** |

#### Phase 3 — Tail Emission Era (after year 10)

Once the 2.1 billion base supply is exhausted (around year 10, height > 21,024,000), the network shifts to perpetual tail emission:

* **Fixed reward**: **1.5 EDX per block**
* **New supply**: ~3.15M EDX per year (**~0.15%** annual inflation)
* **Self-balancing burn**: base transaction fees are burned at the protocol level. As daily transaction volume grows, fee burns eventually outpace tail issuance — at which point EDX turns deflationary on its own.

---

## 5. Security Model

* **No room for ASICs.** RandomX makes L3 cache and memory bandwidth hard requirements, which tips energy efficiency decisively toward consumer CPUs. Large pools lose their structural advantage at the algorithm level.
* **Renting 51% doesn't work.** General-purpose CPU hashrate is spread thin across millions of devices worldwide. There is no NiceHash-style marketplace where an attacker can rent enough commodity CPU power to overpower the network on short notice.
* **Flood and DoS resistance.** Bun provides efficient memory and flow control natively, and a light per-transaction PoW check (anti-spam PoW) protects micro-nodes against network-layer floods and mempool exhaustion attacks.

---

## 6. Roadmap

```
[Phase 1: Genesis & Core] -> [Phase 2: Edge Grid & DePIN] -> [Phase 3: TS Smart Contracts]
```

**Phase 1 — Genesis & Core Foundation**

* High-performance binding between Bun Native FFI and the RandomX shared library, plus tuning;
* Fair launch of mainnet and the start of the 90-day bootstrap period;
* Cross-platform one-click CLI for running a node.

**Phase 2 — EdgeGrid & DePIN Layer**

* Embedded SQLite state cache with lightweight ledger snapshots;
* Public decentralized RPC grid, with service staking and revenue sharing for operators;
* Desktop and mobile dashboards for monitoring nodes.

**Phase 3 — Full-Stack TypeScript Smart Contract VM**

* A lightweight sandboxed VM executing JavaScript/TypeScript natively;
* Distributed execution and storage coordination for Web3 apps across edge nodes.

---

PoW belongs at the edge. With EdgeX, every idle core and every connected device becomes part of the consensus foundation — no farm required.
