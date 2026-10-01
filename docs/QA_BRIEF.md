# ReplayRef — independent QA brief (adversarial re-verification)

Purpose: a second-pass review that *challenges* the build rather than trusting
its own test output. Each item lists what was attacked, the result, and what a
reviewer can re-run independently in minutes.

## Re-run independently

```bash
cargo test --release -p ref-core                 # 13 tests
node scripts/differential.mjs                    # WASM==native, 1200 logs
node scripts/parity.mjs                          # devnode: parity+tamper+gas
sha256sum tests/corpus/valid.jsonl               # corpus frozen pre-referee
git log --reverse --format='%h %s'               # ordering: corpora precede referee
```

## Challenges performed

| # | Attack | Expected | Result |
|---|---|---|---|
| 1 | nibble-order flip (MSB vs LSB packing) | detect divergence | browser packed MSB-first initially — **real bug found & fixed**; replay now round-trips (`fff…` demo log verifies 12294 on-chain) |
| 2 | forged claim `score+1` on real log | reject | 400/400 rejected (`ScoreMismatch`) |
| 3 | wrong-seed replay (same log, different challenge seed) | reject when claim is score>0 | 0 forged claims >0 accepted |
| 4 | overlong log (>450 B) | `TooLong` | 400/400 rejected |
| 5 | non-zero bytes after run end | `NonZeroTrailer` | rejected incl. partial-byte padding |
| 6 | bit-flip / truncate mid-flight | score changes or reject | consistent with native on all 2398 |
| 7 | fuel saturation (thrust >>900 ticks) | fuel floors at 0, run continues | native test `fuel_saturates` passes |
| 8 | rotation wrap (359°→+3°) | stays 0..359 via `rem_euclid` | test passes |
| 9 | out-of-bounds x | immediate `Crashed` | test passes |
| 10 | ceiling thrust | clamped, no overflow | `overflow_bounds` test passes |
| 11 | fixed-point trig symmetry | sin(θ)=sin(180−θ), ±deg | test passes |
| 12 | BigInt seed >2^53 through JS boundary | exact u64 | corpus stores seeds as decimal strings; i64 exports use BigInt — verified |
| 13 | RPC down mid-verify | honest UNVERIFIED, never fake ✓ | UI shows "unreachable — local score only" |

## Known sharp edges (documented, not bugs)

- A **score-0 claim is unforgeable-trivial**: any crash honestly produces 0, so
  "accepted" tamper entries with claim 0 are not security failures. The forgery
  metric is only meaningful on claims >0: **0/545 accepted**.
- `top()` insertion uses strict `>` — equal scores do not displace earlier
  entries (first-come ordering; documented).
- Gas measured only up to ~1045 ticks: no surviving log reached 1800 in the
  corpus (physically rare); verify cost scales ~linearly with ticks.
- `simulate()` on a log whose run is shorter than its byte length *requires*
  zero trailer — a long honest log must be trimmed to its actual byte count
  (packLog handles this).
- Stylus referee stores top-3 only; no pagination, events index score but not
  player rank.

## Evidence files

`evidence/differential.json`, `evidence/parity.json`, `evidence/tamper.json`,
`evidence/gas.json` — all local, all regenerable with the commands above.

## Round 2 — review-fix verification (07aab87)

Independent re-verification of the game/demo NO-GO items, in-browser on a
fresh devnode + rebuilt dist (screenshots `docs/qa/r2-*.png`):

| # | Fix under test | Result |
|---|---|---|
| R1 | landing pad render (Q16.16→px) | gold pad + label visible; replay lands on it (982t, 12294) |
| R2 | first-load arrows (startRun in main) | HUD FLYING on load; ArrowUp burns fuel with zero clicks |
| R3 | 390×844 touch long-press | ~13s hold drains fuel 900→0 continuously; no context menu/selection; clean release; pointercancel clears thrust, no stuck-on |
| R4 | reset/new-seed state | 3 cycles: verdicts, log info, cheat output, styling all cleared; cheats re-disabled |
| R5 | chain states | up: submit→ACCEPTED gas 175660 + leaderboard row; down: honest "not running"/"chain unreachable", submit disabled, local WASM still verifies |
| R6 | 360px layout | zero horizontal overflow; controls-hint visible |

Regression on prior round-1 bugs — all confirmed fixed:
- `ScoreMismatch (computed=12294)` decoded on the +500 cheat (was generic `revert`)
- chain-down verdict is honest text via the liveness probe
- challenge cache recovers after a full devnode restart without page reload

New this round (repo-side, re-runnable):
- `node scripts/wasm_smoke.mjs` — ABI boundary regressions: pad fp→px,
  `simulate_log` rejects len>450 (was truncate; now matches ref-core and the
  contract), demo log still verifies through wasm
- `cargo test -p referee-stylus` — 4 TestVM unit tests: challenge creation/
  BadWindow, verify recompute + InvalidInputs (451B, NonZeroTrailer),
  NotInWindow, ScoreMismatch carries computed, top-3 ordering, score-0 writes
  nothing
- fail-closed guards verified without transactions: `parity.mjs` refuses a
  non-412346 chain (tested against anvil 31337); `sepolia-evidence.mjs`
  refuses the fixture key and any non-421614 chain before any signature

## Round 3 — leaderboard dedup (post-review P1)

Independent review found `insert_top` never removed a player's prior entry:
improving your own best let one address occupy multiple top-3 slots and
evict other players. Fixed: the player's existing entry is evicted and the
board compacted before the new score is inserted. Regression tests cover
the exact repro (p9 lands, p1 improves 12293→12301→12310 → p1 once + p9
survives), a full 3-player board plus an improvement entering from outside
top-3, duplicate-address absence, zero-score submits writing nothing, and
tie ordering (strict `>` keeps the earlier entry). 7/7 pass via
`cargo test -p referee-stylus`; local-chain parity/tamper/gas re-run on the
fixed contract — 0 mismatches.
