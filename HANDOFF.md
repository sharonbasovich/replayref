# Coordinator handoff — external gates (all require the human's authorization)

Local build is complete and self-verified; nothing below was executed in-session.

## 1. Publish the repo (one step)
Devin's GitHub App token cannot create user repos. After creating
`sharonbasovich/replayref` (public, empty):
```
cd replayref && git remote add origin https://github.com/sharonbasovich/replayref.git
git push -u origin main        # Devin app installation can push once the repo exists
```
Or upload `replayref.bundle` (`git clone replayref.bundle`) — identical history.

## 2. GitHub Pages demo (free, no secrets)
- Repo Settings → Pages → Source: **GitHub Actions**.
- The committed workflow `.github/workflows/pages.yml` builds `web/` with
  `--base /replayref/` and deploys. Live at `https://sharonbasovich.github.io/replayref/`.
- On Pages the game, verified replay, and local WASM verification all work;
  the chain panel honestly reports no referee attached (local devnode only).

## 3. HackQuest / Arbitrum gates (coordinator-owned)
- HackQuest requires an Arbitrum deployment (Sepolia acceptable per coordinator note).
- To deploy the Stylus referee to Sepolia: `cargo stylus deploy --endpoint $SEPOLIA_RPC
  --private-key $DEPLOYER_PRIVATE_KEY` — key read from env only, never stored in repo.
- Then set `REFEREE`/`RPC_URL` in `web/src/chain.ts` to the Sepolia deployment and
  rebuild; evidence JSONs should be regenerated against that chain and the README
  table updated to distinguish PUBLIC-CHAIN from local evidence.

## 4. Claim-map reminders for the submission text
Consistency verification only — NOT bot-proof / not proof a human played; "ERC-20-
compatible" never "Paxos USDG"; gas numbers are local-devnode, not Arbitrum One;
disclose the AI-assisted (Devin) build.
