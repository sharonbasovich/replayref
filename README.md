# ReplayRef

**Every arcade leaderboard has a number-one score that's physically impossible.**
ReplayRef makes the chain re-play a game's *entire input log* before accepting a score —
the leaderboard can only contain runs the chain itself reproduced.

**Robots welcome. Liars aren't.** A bot that plays honestly is a legitimate entry;
a human that lies about their run is not. ReplayRef checks *consistency* — it does
not prove a human played and is not "anti-bot" or "anti-cheat" in the general sense.

> **Scope honesty:** everything in this repo runs locally — native Rust, a 4 KB
> `wasm32` module, and an Arbitrum **Stylus** referee contract measured on a
> **local nitro devnode**. Nothing was deployed to or measured on a public chain.
> No wallets, real funds, or real tokens are involved anywhere.

## What it is

- `core/` — `ref-core`: `no_std`, integer-only (Q16.16 fixed-point) lunar-lander
  simulation. 60 ticks/sec, max 1800 ticks, one 2-bit input per tick packed 4/byte
  (≤ 450 bytes per run). The same code is compiled three ways:
  - native CLI (`replaysim`, `autopilot`),
  - browser WASM via `wasm-abi` (the game you play is *the* scored code path),
  - Stylus referee contract (Rust→WASM on Arbitrum).
- `contracts/referee-stylus/` — the referee. `verify(id, inputs)` re-simulates the
  log on-chain and returns the score (`eth_call`, walletless). `submit(id, inputs,
  claimed)` writes to the leaderboard only if the claimed score equals the
  recomputed one.
- `web/` — Vite+TS game + referee panel: play or watch a verified replay, then see
  local WASM and chain verification side-by-side, plus a cheat demo.
- `tests/corpus/` — frozen corpora: `valid.jsonl` (1200 seeded logs) and
  `tamper.jsonl` (2398 mutations/forgeries), generated *before* the referee
  implementation from predeclared seeds (`VALID_SEED=0xB16B00B5`,
  `TAMPER_SEED=0xDEADBEEF42`).
- `evidence/` — machine-readable results quoted below.

## Score

`landed ? 10_000 + fuel_left*3 + (1800 − ticks) : 0` — land on the gold pad,
slow (|vx| ≤ 0.8 px/t, fall ≤ 1.2 px/t), upright (|rot| ≤ 12°).

## Measured evidence (all local)

| Gate | Result | Evidence |
|---|---|---|
| native == browser WASM, 1200 seeded logs | **0 mismatches** | `evidence/differential.json` |
| Stylus `verify` == native, 1200 logs | **0 mismatches** | `evidence/parity.json` |
| tampered/forged corpus, on-chain vs native | **0 mismatches** | `evidence/tamper.json` |
| forged claims > 0 accepted | **0 / 545** | `evidence/tamper.json` |
| `submit` gas (real txs, local devnode) | **71,956 / 81,068 / 83,405** @ 300/904/1045 ticks | `evidence/gas.json` |
| `verify` gas estimate (`eth_call`) | **67,724–79,309** | `evidence/gas.json` |

Tamper mutations tested: bit flips, truncation, overlong logs (>450 B), claim+1
forgeries, wrong-seed replays, non-zero padding. Note: a score-**0** claim is
trivially true of any crashing log — forgery success is only meaningful on
claims > 0, where **every** forgery was rejected. Malformed logs revert with
`InvalidInputs` (`TooLong` / `NonZeroTrailer`).

## Reproduce

```bash
# 1. native core: tests + corpus generation + differential
cargo test --release -p ref-core            # 13 tests incl. boundary/overflow/malformed
cargo build --release                       # replaysim + autopilot binaries
python3 scripts/gen_corpus.py               # regenerates the frozen corpora
cargo build --release --target wasm32-unknown-unknown -p wasm-abi
node scripts/differential.mjs               # -> evidence/differential.json

# 2. Stylus referee on a local nitro devnode (fixture keys only, local chain)
cd ~/nitro-devnode && ./run-dev-node.sh     # OffchainLabs nitro-devnode, chain 412346
cd contracts/referee-stylus && cargo stylus deploy \
  --endpoint http://127.0.0.1:8547 --private-key <devnode-fixture-key> --no-verify
node scripts/parity.mjs                     # -> evidence/parity|tamper|gas.json

# 3. web demo
cd web && npm install && npm run dev        # proxies /rpc -> 127.0.0.1:8547
```

Toolchain pinned: rust 1.97.1 (`wasm32-unknown-unknown`), cargo-stylus 0.10.9,
stylus-sdk 0.10.9, foundry 1.8.3, node 22+, vite 7.1.7, viem 2.38.4.

## Input log format

2 bits/tick, tick 0 = low bits of byte 0: `0` idle, `1` thrust, `2` rotate-left,
`3` rotate-right. Everything after the run ends must be zero — `NonZeroTrailer`
otherwise; >450 bytes → `TooLong`.

## Limitations

- **Consistency, not humanity.** The referee re-simulates bytes; it cannot tell
  a human's log from a bot's or a precomputed one. "Robots welcome" is a feature:
  honest automation is first-class here.
- **Local-only evidence.** All chain results come from a throwaway nitro devnode
  (chain id 412346) using the documented public test-fixture account that ships
  in OffchainLabs' `run-dev-node.sh`. No public chain, no real funds, no real
  tokens, no deployed leaderboard.
- **Gas numbers are local-devnode measurements**, not Arbitrum One, and only at
  the tick counts actually executed (≤ ~1045); logs that never land are the
  only way to reach 1800 ticks.
- **A score-0 claim cannot be forged** — every crash honestly scores 0.
- **No prize/escrow contract** in this build (cut for deadline); `createChallenge`'s
  `season` parameter is an inert placeholder.
- The Stylus referee is a naive top-3 store, not a production leaderboard.

## AI disclosure

This project was designed and implemented end-to-end by Devin (Cognition AI)
inside the buildathon window, directed by a human coordinator: all Rust
(`ref-core`, `wasm-abi`, Stylus referee), corpora and harnesses, the web demo,
tests, docs, and demo media. No code was reused from prior hackathons or external
projects; third-party code is limited to declared dependencies and OffchainLabs'
public `nitro-devnode` tooling. The human coordinator owns external gates:
registration, wallet/keys, any public-chain deployment, and submission.

## License

MIT — see `LICENSE`.
