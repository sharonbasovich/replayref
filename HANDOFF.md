# Coordinator handoff — external gates

Public source and free hosting are owner-authorized and already done
(repo pushed, Pages via GitHub Actions). What remains is the coordinator's
credentialled/registration surface — none of it was executed in-session.

## 1. Repo + Pages — DONE

- Source pushed to `main` on https://github.com/sharonbasovich/replayref
- Pages live at https://sharonbasovich.github.io/replayref/ via
  `.github/workflows/pages.yml` (builds `web/` with `--base /replayref/`).
- On Pages the game, verified replay, and local WASM verification all work;
  the referee panel honestly reports "unreachable / local only" — there is no
  public-chain referee yet.

## 2. HackQuest form needs an Arbitrum contract address (coordinator-owned)

- HackQuest registration is done; the form wants a deployed referee address.
- Deploy to Sepolia (accepted per coordinator note):
  ```
  cd contracts/referee-stylus
  cargo stylus deploy --endpoint $SEPOLIA_RPC \
    --private-key $DEPLOYER_PRIVATE_KEY   # env-only, never committed
  ```
- Then point `REFEREE`/`RPC_URL` in `web/src/chain.ts` at that deployment,
  regenerate `evidence/*.json` against Sepolia, and update the README table —
  public-chain evidence must be labelled separately from local-devnode evidence.

## 3. Claim-map reminders for the submission text

Consistency verification only — NOT bot-proof / not proof a human played;
"ERC-20-compatible", never "Paxos USDG"; gas numbers are local-devnode, not
Arbitrum One; disclose the AI-assisted (Devin) build.
