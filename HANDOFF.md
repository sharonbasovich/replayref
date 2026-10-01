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

Step 4 — wire the web app at the deployed referee:

- `web/src/chain.ts`: set `REFEREE` to `REFEREE_ADDR`, `RPC_URL` to a Sepolia
  RPC (e.g. `https://sepolia-rollup.arbitrum.io/rpc`), the chain def to
  Arbitrum Sepolia (id 421614), and replace the dev-node fixture signer with
  the intended public submitter flow.
- `scripts/parity.mjs`: point `RPC` at Sepolia and re-run to regenerate
  `evidence/parity.json`, `evidence/tamper.json`, `evidence/gas.json`.
- Update the README evidence table — label the new numbers PUBLIC-CHAIN
  (Arbitrum Sepolia), distinct from the local-devnode rows.

Step 5 — HackQuest form: paste `REFEREE_ADDR` (Arbitrum Sepolia) into the
final submission form. Registration itself is already complete.

Artifact references: contract source `contracts/referee-stylus/` (stylus-sdk
0.10.9), interface mirror `contracts/referee-stylus/IReferee.sol`, ABI glue
`web/src/chain.ts`, demo challenge seed `7777777` / log `web/public/demo_log.json`.

## 3. Claim-map reminders for the submission text

Consistency verification only — NOT bot-proof / not proof a human played;
"ERC-20-compatible", never "Paxos USDG"; gas numbers are local-devnode unless
Step 4 regenerates them on Sepolia; disclose the AI-assisted (Devin) build.
