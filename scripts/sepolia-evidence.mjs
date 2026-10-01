#!/usr/bin/env node
// sepolia-evidence.mjs — OWNER-EXECUTED public-chain evidence collection.
//
// This script sends REAL transactions on Arbitrum Sepolia (chain id 421614)
// using the owner's key from the environment. It is intentionally isolated
// from scripts/parity.mjs, which uses the public nitro-devnode fixture key
// and is guarded to local chain 412346 only.
//
// Usage (owner machine, owner key — never committed):
//   export DEPLOYER_KEY=0x<sepolia-funded-key>
//   export REFEREE_ADDR=0x<deployed-referee>
//   export SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc   # optional, this is the default
//   node scripts/sepolia-evidence.mjs
//
// Writes evidence/sepolia.json, labelled PUBLIC-CHAIN. This file was NOT run
// during the build session; it exists so the coordinator can produce real
// public-chain numbers after deployment.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, parseAbi, defineChain,
  keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ARB_SEPOLIA_ID = 421614;
const CHALLENGE_SEED = 7777777n;
const EXPECTED_DEMO_SCORE = 12294;

const RPC = process.env.SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const REFEREE = process.env.REFEREE_ADDR;
const KEY = process.env.DEPLOYER_KEY;

// the nitro-devnode fixture key is a published Offchain Labs test key — it
// must never sign outside the local devnode. Refuse it outright here.
const FIXTURE_KEY =
  "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659";

const ABI = parseAbi([
  "function verify(uint256 id, bytes inputs) view returns (uint256)",
  "function submit(uint256 id, bytes inputs, uint256 claimed) returns (uint256)",
  "function createChallenge(uint64 seed, uint64 start, uint64 end, address season) returns (uint256)",
  "function numChallenges() view returns (uint256)",
  "function challengeSeed(uint256 id) view returns (uint256)",
  "function best(uint256 id, address player) view returns (uint256)",
  "function top(uint256 id, uint256 i) view returns (address, uint256)",
]);

const errName = (e) => {
  const m = String(e?.shortMessage || e?.message || e).match(/(BadWindow|ChallengeNotFound|InvalidInputs|ScoreMismatch|NotInWindow)/);
  return m ? m[1] : String(e).slice(0, 160);
};

async function main() {
  if (!KEY) throw new Error("DEPLOYER_KEY env var required (owner key — never committed)");
  if (KEY.toLowerCase() === FIXTURE_KEY.toLowerCase()) {
    throw new Error("refusing: DEPLOYER_KEY is the public nitro-devnode fixture key");
  }
  if (!REFEREE) throw new Error("REFEREE_ADDR env var required (deployed referee address)");

  const chain = defineChain({
    id: ARB_SEPOLIA_ID, name: "arbitrum-sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wal = createWalletClient({ account, chain, transport: http(RPC) });

  const cid = await pub.getChainId();
  if (cid !== ARB_SEPOLIA_ID) {
    throw new Error(`refusing to run: expected Arbitrum Sepolia chain id ${ARB_SEPOLIA_ID}, got ${cid} — no transactions sent`);
  }

  // create a fresh challenge and pin the REAL id from ChallengeCreated —
  // creation is permissionless, so an index assumption can attach to someone
  // else's challenge. The seed is then re-read onchain.
  const created = await wal.writeContract({
    address: REFEREE, abi: ABI, functionName: "createChallenge",
    args: [CHALLENGE_SEED, 1n, 4102444800n, "0x0000000000000000000000000000000000000000"],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: created });
  const topic0 = keccak256(toHex("ChallengeCreated(uint256,uint64,uint64,uint64,address)"));
  const ev = rcpt.logs.find((l) => l.topics[0] === topic0);
  if (!ev) throw new Error("createChallenge mined but emitted no ChallengeCreated event");
  const CH_ID = BigInt(ev.topics[1]);
  const seedOnChain = await pub.readContract({
    address: REFEREE, abi: ABI, functionName: "challengeSeed", args: [CH_ID],
  });
  if (seedOnChain !== CHALLENGE_SEED) {
    throw new Error(`challenge ${CH_ID} carries seed ${seedOnChain}, expected ${CHALLENGE_SEED} — refusing`);
  }
  console.log("created+verified challenge", CH_ID.toString(), "seed", seedOnChain.toString());

  const demo = JSON.parse(readFileSync(resolve(root, "web/public/demo_log.json"), "utf8"));
  const inputs = `0x${demo.inputs}`;

  const verifyScore = await pub.readContract({
    address: REFEREE, abi: ABI, functionName: "verify", args: [CH_ID, inputs],
  });
  console.log("verify() demo log ->", verifyScore.toString());

  const gasRows = [];
  try {
    const hash = await wal.writeContract({
      address: REFEREE, abi: ABI, functionName: "submit",
      args: [CH_ID, inputs, verifyScore],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const acceptedTopic = keccak256(toHex("RunAccepted(uint256,address,uint32,bytes32)"));
    gasRows.push({
      kind: "submit_landed", ticks: demo.ticks, score: verifyScore.toString(),
      wrote_run_accepted: rc.logs.some((l) => l.topics[0] === acceptedTopic),
      tx: hash, gas_used: rc.gasUsed.toString(), receipt_status: rc.status,
    });
    console.log("submit gas", rc.gasUsed.toString());
  } catch (e) {
    gasRows.push({ kind: "submit_landed", ticks: demo.ticks, error: errName(e) });
    console.log("submit reverted:", errName(e));
  }
  try {
    const g = await pub.estimateContractGas({
      address: REFEREE, abi: ABI, functionName: "verify",
      args: [CH_ID, inputs], account: account.address,
    });
    gasRows.push({ kind: "verify_eth_call", ticks: demo.ticks, status: "landed", gas_estimated: g.toString() });
  } catch (e) {
    gasRows.push({ kind: "verify_eth_call", ticks: demo.ticks, error: errName(e) });
  }

  const board = [];
  for (let i = 0n; i < 3n; i++) {
    const [p, s] = await pub.readContract({ address: REFEREE, abi: ABI, functionName: "top", args: [CH_ID, i] });
    board.push({ slot: i.toString(), player: p, score: s.toString() });
  }

  const report = {
    generated_at: new Date().toISOString(),
    environment: "PUBLIC-CHAIN — Arbitrum Sepolia (chain id 421614)",
    referee: REFEREE, challenge_id: CH_ID.toString(),
    challenge_seed_verified: seedOnChain.toString(),
    demo_log: { ticks: demo.ticks, bytes: demo.inputs.length / 2 },
    verify_score: verifyScore.toString(),
    verify_matches_expected: verifyScore.toString() === String(EXPECTED_DEMO_SCORE),
    leaderboard: board,
    gas_rows: gasRows,
    note: "Real transactions on Arbitrum Sepolia by the owner key. Compare against evidence/gas.json local-devnode rows — do not mix the two.",
  };
  mkdirSync(resolve(root, "evidence"), { recursive: true });
  writeFileSync(resolve(root, "evidence/sepolia.json"), JSON.stringify(report, null, 2));
  console.log("wrote evidence/sepolia.json");
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
