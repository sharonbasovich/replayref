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
