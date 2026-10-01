# ReplayRef QA plan — end-to-end, local devnode

App under test: http://localhost:4173/ (vite preview of web/dist, /rpc → 127.0.0.1:8547 nitro devnode, chain 412346, referee at 0x525c2aba45f66987217323e8a05ea400c65d06dc).
Evidence: recording + screenshots into /home/ubuntu/repos/replayref/docs/qa/.

Ground truth from code (web/src/main.ts, chain.ts, public/demo_log.json):
- demo log: seed 7777777, 982 ticks, expected_score 12294.
- finishRun prints `local: LANDED in 982 ticks → score 12294` and `input log: 982 ticks → 246 bytes (cap 450) · hex …`.
- chainVerify ok prints `chain (local devnode): score 12294 ✓`; unreachable prints `chain: unreachable — local score only, UNVERIFIED` (never a fake check).
- Submit ok prints `chain: ACCEPTED score 12294 — gas N (local devnode tx 0x…)`; leaderboard `#1 0x3f1Eae7D… 12294`.
- Cheat decode: score → `REJECTED — ScoreMismatch (computed=12294)`; byte → recomputed score ≠ claim or revert; seed → `chain computed X, not 12294`.
- Touch pad appears only at max-width 980px; controls-hint hides.

## Tests (recorded, annotated)

T1 Golden path.
- Click "▶ Watch verified replay". Autopilot should fly ~16s and land on the pad.
- PASS iff: hud ends LANDED ~t 982; `local: LANDED in 982 ticks → score 12294`; `chain (local devnode): score 12294 ✓`; claim row visible with 12294; log info `982 ticks → 246 bytes (cap 450)`.
- Then click "Submit to chain". PASS iff `chain: ACCEPTED score 12294 — gas …` and a leaderboard row `#1 … 12294` appears.

T2 Cheat demo (same run state).
- "Claim +500" → PASS iff cheat-out shows `REJECTED — ScoreMismatch (computed=12294)` + "the +500 lie never landed" (red).
- "Flip an input byte" → PASS iff shows either `chain re-simulated the edited log → score X (your claim said 12294)` with X ≠ 12294, or `REJECTED — …`.
- "Wrong seed replay" → PASS iff shows `same log, wrong seed → chain computed Y, not 12294` (Y ≠ 12294) or a REJECTED decode.

T3 Manual play + repeated resets.
- Click Reset (and press R). Ship FLYING; hold ArrowUp a few seconds; let it crash or land.
- PASS iff: hud ticks advance, fuel drops while thrusting, run ends with verdict local line (CRASHED → `rejected:…` or LANDED → score), chain verdict follows, log-info shows byte count. Reset twice in a row must clear verdicts to `—` and restart cleanly each time.

T4 Failure path (chain down → recovery).
- `pkill -f run-dev-node` (docker --rm container dies; confirm eth_chainId fails).
- In page (no reload): click Reset, let ship free-fall crash. PASS iff v-chain shows `chain: unreachable — local score only, UNVERIFIED` in warn style — and never a ✓.
- Restart: `cd /home/ubuntu/nitro-devnode && PATH=$HOME/.foundry/bin:$PATH ./run-dev-node.sh` (nohup, log → /home/ubuntu/devnode.log). Check eth_getCode referee; if `0x`, redeploy: `cd contracts/referee-stylus && cargo stylus deploy --endpoint http://127.0.0.1:8547 --private-key 0xb6b1…0659 --no-verify`.
- Probe without reload first (stale seedToChallenge map may surface ChallengeNotFound — a real bug if so; capture it). Then reload page, replay again. PASS iff chain verdict returns `chain (local devnode): score 12294 ✓`.

T5 Mobile layout (~390px wide).
- Resize Chrome window narrow. PASS iff: panels stack below canvas (1 column), touch-pad row (⟲ ↑ ⟳) visible, controls-hint hidden.
- Click Reset then press-and-hold ↑ touch button: fuel decreases / vy changes — buttons work. Restore window.

T6 Console errors.
- Collect browser console after each stage. PASS iff no unexpected errors during T1–T3/T5; /rpc fetch failures during T4 are expected and must be labelled as such.

## Adversarial notes
- The ✓ must come from a real RPC: T4's UNVERIFIED distinguishes honest from faked status.
- Claim +500 decoding `ScoreMismatch(computed=12294)` proves the chain actually re-simulated, not pattern-matched.
- Without page reload after chain restart, stale challenge cache is a probe for a real bug — report either way.
