# Coordinator handoff — external gates

Public source and free hosting are owner-authorized and already done
(repo pushed, Pages via GitHub Actions). What remains is the coordinator's
credentialled/registration surface — none of it was executed in-session.

## 1. Repo + Pages — DONE

- Source pushed to `main` on https://github.com/sharonbasovich/replayref
- Pages live at https://sharonbasovich.github.io/replayref/ via
  `.github/workflows/pages.yml` (builds `web/` with `--base /replayref/`).
- On Pages the game, verified replay, and local WASM verification all work;
  the referee panel honestly reports "no Arbitrum deployment connected" —
  there is no public-chain referee yet.

## 2. Sepolia deployment checklist (owner-executable)

Everything below runs on the owner's machine with the owner's wallet.
The deployer key stays in the shell environment — never committed.

Prereqs (versions pinned to what this repo was tested with):

```
cargo install cargo-stylus --version 0.10.9   # ~5 min, needs Rust 1.97.x
curl -L https://foundry.paradigm.xyz | bash && foundryup   # provides `cast`
```

Step 1 — build + check the referee (offline, no key needed):

```
cd contracts/referee-stylus
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc
```

Step 2 — deploy to Arbitrum Sepolia (owner key in env only):

```
export DEPLOYER_KEY=0x<sepolia-funded-owner-key>   # needs Sepolia ETH
cargo stylus deploy \
  --endpoint https://sepolia-rollup.arbitrum.io/rpc \
  --private-key $DEPLOYER_KEY
# note the printed contract address -> REFEREE_ADDR
```

Step 3 — create the demo challenge (seed 7777777, wide open window):

```
export SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
export REFEREE_ADDR=0x<address-from-step-2>
cast send $REFEREE_ADDR \
  "createChallenge(uint64,uint64,uint64,address)(uint256)" \
  7777777 1 4102444800 0x0000000000000000000000000000000000000000 \
  --rpc-url $SEPOLIA_RPC --private-key $DEPLOYER_KEY
```

Step 4 — verify the challenge id and collect public-chain evidence.

`createChallenge` is permissionless — do NOT assume the returned id is any
particular index. Read the id from the `ChallengeCreated` event in the tx
receipt and re-read `challengeSeed(id)` to confirm it is `7777777` before
using it anywhere.

- `scripts/sepolia-evidence.mjs` is the owner-executed script for this. It
  reads `DEPLOYER_KEY`, `REFEREE_ADDR`, `SEPOLIA_RPC` from the environment
  (the dev-node fixture key is hard-refused), checks the chain id is
  Arbitrum Sepolia (421614), creates a challenge, verifies the returned id
  carries seed 7777777, then runs verify/submit and writes
  `evidence/sepolia.json` — labelled PUBLIC-CHAIN so it can never be
  confused with local-devnode rows.
- Do **not** repoint `scripts/parity.mjs` at Sepolia: its submit path uses
  the public dev-node fixture key and is now guarded to refuse any chain
  that is not localhost + chain id 412346. Use `sepolia-evidence.mjs` or
  an owner wallet instead.
- Update the README evidence table — label the new numbers PUBLIC-CHAIN
  (Arbitrum Sepolia), distinct from the local-devnode rows.

Step 4b — optional: wire the web app at the deployed referee.

- `web/src/chain.ts` keeps the fixture signer behind `assertLocalChain()`
  — it refuses to sign unless the page is on localhost AND the chain id is
  412346, so the public demo can never send a fixture-key transaction. To
  offer real submission on Sepolia, add an owner-controlled wallet route
  (e.g. a connect-wallet button) that submits only after the player signs —
  and set `REFEREE`/`RPC_URL` to the Sepolia values. Until then the hosted
  demo stays local-WASM verification only, which is what it says on the
  page.

Step 5 — HackQuest form: paste `REFEREE_ADDR` (Arbitrum Sepolia) into the
final submission form. Registration itself is already complete.

Artifact references: contract source `contracts/referee-stylus/` (stylus-sdk
0.10.9), interface mirror `contracts/referee-stylus/IReferee.sol`, ABI glue
`web/src/chain.ts`, public-chain evidence script `scripts/sepolia-evidence.mjs`,
demo challenge seed `7777777` / log `web/public/demo_log.json`.

## 3. Claim-map reminders for the submission text

Consistency verification only — NOT bot-proof / not proof a human played;
"ERC-20-compatible", never "Paxos USDG"; gas numbers are local-devnode unless
Step 4 regenerates them on Sepolia; disclose the AI-assisted (Devin) build.
