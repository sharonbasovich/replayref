#!/usr/bin/env node
// parity.mjs — onchain parity + tamper + gas evidence against the local Nitro
// devnode (chain 412346). LOCAL ONLY: uses the node's built-in dev account,
// which is a public, non-secret fixture hardcoded in OffchainLabs' own
// run-dev-node.sh. Nothing here touches a public chain.
//
//   node scripts/parity.mjs [--rpc http://127.0.0.1:8547] [--referee 0x...]
//
// Writes: evidence/parity.json, evidence/tamper.json, evidence/gas.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, parseAbi, defineChain,
  keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const RPC = arg("--rpc", "http://127.0.0.1:8547");
const REFEREE = arg("--referee", "0x525c2aba45f66987217323e8a05ea400c65d06dc");
const CHALLENGE_SEED = 7777777n;
// nitro-devnode built-in dev account (public fixture, local-only)
const DEV_KEY = "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659";

const chain = defineChain({
  id: 412346, name: "nitro-devnode",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const account = privateKeyToAccount(DEV_KEY);
const pub = createPublicClient({ chain, transport: http() });
const wal = createWalletClient({ account, chain, transport: http() });

const ABI = parseAbi([
  "function createChallenge(uint64 seed, uint64 start, uint64 end, address season) returns (uint256)",
  "function verify(uint256 id, bytes inputs) view returns (uint256)",
  "function submit(uint256 id, bytes inputs, uint256 claimed) returns (uint256)",
  "function numChallenges() view returns (uint256)",
  "function challengeSeed(uint256 id) view returns (uint256)",
  "function best(uint256 id, address player) view returns (uint256)",
  "function top(uint256 id, uint256 i) view returns (address, uint256)",
  "error ScoreMismatch(uint32 computed)",
  "error InvalidInputs()",
  "error NotInWindow(uint64 start, uint64 end, uint64 now)",
  "error ChallengeNotFound(uint256 id)",
]);

const j = (p) => readFileSync(resolve(root, p), "utf8").trim().split("\n").map(JSON.parse);
const valid = j("tests/corpus/valid.jsonl");
const tamper = j("tests/corpus/tamper.jsonl");
const nativeCh = new Map(j("tests/out/native_at_challenge.jsonl").map((r) => [r.id, r.result]));
const nativeBase = new Map(j("tests/out/native_base.jsonl").map((r) => [r.id, r.result]));
const nativeTampCh = new Map(j("tests/out/native_tamper_challenge.jsonl").map((r) => [r.id, r.result]));

const errName = (e) =>
  e?.cause?.data?.errorName ?? e?.data?.errorName ?? e?.shortMessage?.match(/Error: (\w+)/)?.[1] ?? "revert";

async function ethVerify(id, inputsHex) {
  try {
    const v = await pub.readContract({
      address: REFEREE, abi: ABI, functionName: "verify",
      args: [id, `0x${inputsHex}`],
    });
    return { score: v };
  } catch (e) {
    return { revert: errName(e) };
  }
}

async function main() {
  // FAIL CLOSED: the fixture dev key must never sign outside the local devnode.
  // Guard 1: the RPC endpoint itself must be loopback — a remote URL means
  // this key would sign on a network it doesn't belong to.
  const rpcHost = new URL(RPC).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(rpcHost)) {
    console.error(`refusing to run: RPC host "${rpcHost}" is not loopback. The fixture key is local-only — no transactions sent.`);
    process.exit(1);
  }
  // Guard 2: the loopback endpoint must actually serve the nitro devnode chain.
  const cid = await pub.getChainId();
  if (cid !== 412346) {
    console.error(`refusing to run: expected nitro devnode chain id 412346, got ${cid}. The fixture key is local-only — no transactions sent.`);
    process.exit(1);
  }
  const block0 = await pub.getBlockNumber();
  // 1. create a fresh challenge and pin the REAL id from the ChallengeCreated
  // event — never assume an index (creation is permissionless; another caller
  // could front-run any index we guessed). The seed is then re-read onchain to
  // prove the id we use actually carries our seed.
  const created = await wal.writeContract({
    address: REFEREE, abi: ABI, functionName: "createChallenge",
    args: [CHALLENGE_SEED, 1n, 4102444800n, "0x0000000000000000000000000000000000000000"],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: created });
  const topic0 = keccak256(toHex("ChallengeCreated(uint256,uint64,uint64,uint64,address)"));
  const acceptedTopic = keccak256(toHex("RunAccepted(uint256,address,uint32,bytes32)"));
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

  // 2. parity: onchain verify == native sim under the challenge seed
  const t0 = Date.now();
  let mismatches = [];
  const scoreById = new Map();
  const CHUNK = 32;
  for (let i = 0; i < valid.length; i += CHUNK) {
    await Promise.all(valid.slice(i, i + CHUNK).map(async (e) => {
      const c = await ethVerify(CH_ID, e.inputs);
      const nat = nativeCh.get(e.id);
      const natScore = nat?.score !== undefined ? BigInt(nat.score) : null;
      scoreById.set(e.id, c.score ?? null);
      const agree = (c.revert && nat?.reject) || (c.score !== undefined && c.score === natScore);
      if (!agree) mismatches.push({ id: e.id, onchain: c, native: nat });
    }));
    process.stderr.write(`\rparity ${Math.min(i + CHUNK, valid.length)}/${valid.length}`);
  }
  console.error("");
  const parity = {
    generated_at: new Date().toISOString(),
    chain: "nitro-devnode local (chain id 412346)",
    referee: REFEREE, challenge_id: CH_ID.toString(), challenge_seed: CHALLENGE_SEED.toString(),
    block: block0.toString(), n: valid.length,
    mismatches: mismatches.length, samples: mismatches.slice(0, 20),
    note: "LOCAL devnode evidence only — not a public-chain deployment.",
  };

  // 3. tamper corpus. Forgery only matters on claims > 0: a score-0 claim is
  // trivially "true" for any crashing log and cannot be distinguished.
  let accepted_unexpectedly = 0, rejected = 0;
  let claims_gt0 = 0, claims_gt0_accepted = 0;
  let tamper_parity_mismatches = 0;
  const perMutation = {};
  const acceptedSamples = [];
  for (let i = 0; i < tamper.length; i += CHUNK) {
    await Promise.all(tamper.slice(i, i + CHUNK).map(async (e) => {
      const base = nativeBase.get(e.base_id);
      const claim = BigInt(base?.score ?? 0) + BigInt(e.claim_offset ?? 0);
      const c = await ethVerify(CH_ID, e.inputs);
      const pass = c.score !== undefined && c.score === claim;
      // onchain-vs-native parity under the challenge seed
      const nat = nativeTampCh.get(e.id);
      const agree = (c.revert && nat?.reject) ||
        (c.score !== undefined && nat?.score !== undefined && c.score === BigInt(nat.score));
      if (!agree) tamper_parity_mismatches++;
      perMutation[e.mutation] ??= { n: 0, rejected: 0, accepted_unexpectedly: 0, accepted_gt0: 0 };
      perMutation[e.mutation].n++;
      if (claim > 0n) claims_gt0++;
      if (pass) {
        accepted_unexpectedly++;
        perMutation[e.mutation].accepted_unexpectedly++;
        if (claim > 0n) { claims_gt0_accepted++; perMutation[e.mutation].accepted_gt0++; }
        if (acceptedSamples.length < 20) acceptedSamples.push({ id: e.id, m: e.mutation, claim: claim.toString(), score: c.score?.toString() });
      } else {
        rejected++;
        perMutation[e.mutation].rejected++;
      }
    }));
    process.stderr.write(`\rtamper ${Math.min(i + CHUNK, tamper.length)}/${tamper.length}`);
  }
  console.error("");
  const tamperReport = {
    generated_at: new Date().toISOString(), chain: parity.chain, referee: REFEREE,
    n: tamper.length, rejected, accepted_unexpectedly,
    claims_gt0, claims_gt0_accepted,
    onchain_native_parity_mismatches: tamper_parity_mismatches,
    per_mutation: perMutation,
    accepted_samples: acceptedSamples,
    note: "claim = native base score + claim_offset. verify() returning ==claim counts as forgery success. A 0-score claim is true of any crashing log, so forgery success is only meaningful on claims > 0.",
  };

  // 4. gas: real submit txs. LANDED runs (score > 0) write best/top entries;
  // crashed score-0 runs only replay and write nothing — rows are labelled so
  // the two are never conflated. The demo log is included as the canonical
  // landed submission.
  const want = [300, 900, 1800];
  const pick = (w, landed) => {
    let best = null;
    for (const e of valid) {
      const nat = nativeCh.get(e.id);
      if (landed && nat?.status !== "landed") continue;
      if (!landed && nat?.status === "landed") continue;
      const d = Math.abs((nat?.ticks ?? 0) - w);
      if (!best || d < best.d) best = { e, d, ticks: nat?.ticks, status: nat?.status };
    }
    return best;
  };
  const demoLog = JSON.parse(readFileSync(resolve(root, "web/public/demo_log.json"), "utf8"));
  const demoEntry = { e: { id: "demo", inputs: demoLog.inputs }, ticks: demoLog.ticks, status: "landed" };
  const submitCases = [
    { b: pick(900, true) ?? demoEntry, landed: true },
    { b: demoEntry, landed: true },
    ...want.map((w) => ({ b: pick(w, false), landed: false })),
  ];
  const gasRows = [];
  for (const { b, landed } of submitCases) {
    if (!b) continue;
    const score = b.e.id === "demo" ? BigInt(demoLog.expected_score) : scoreById.get(b.e.id);
    if (score === null || score === undefined) continue;
    try {
      const hash = await wal.writeContract({
        address: REFEREE, abi: ABI, functionName: "submit",
        args: [CH_ID, `0x${b.e.inputs}`, score],
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      const wrote = rc.logs.some((l) => l.topics[0] === acceptedTopic);
      gasRows.push({
        kind: landed ? "submit_landed" : "submit_score0_replay_only",
        ticks: b.ticks, status: b.status, score: score.toString(),
        wrote_run_accepted: wrote,
        tx: hash, gas_used: rc.gasUsed.toString(), receipt_status: rc.status,
      });
    } catch (e) {
      gasRows.push({ kind: landed ? "submit_landed" : "submit_score0_replay_only", ticks: b.ticks, error: errName(e) });
    }
  }
  // verify() estimate at same ticks
  for (const b of [pick(300, false), pick(900, false), pick(1800, false), demoEntry]) {
    if (!b) continue;
    try {
      const g = await pub.estimateContractGas({
        address: REFEREE, abi: ABI, functionName: "verify",
        args: [CH_ID, `0x${b.e.inputs}`], account: account.address,
      });
      gasRows.push({ kind: "verify_eth_call", ticks: b.ticks, status: b.status, gas_estimated: g.toString() });
    } catch (e) {
      gasRows.push({ kind: "verify_eth_call", ticks: b.ticks, error: errName(e) });
    }
  }
  const gas = {
    generated_at: new Date().toISOString(), chain: parity.chain, referee: REFEREE,
    rows: gasRows,
    note: "Local nitro devnode, real receipts. submit_landed rows carry a landed log; whether they write is recorded per-row as wrote_run_accepted (a submit only emits RunAccepted when it beats the player's prior best). submit_score0_replay_only rows replay a crashed run and never write. Public-chain figures need a funded deployer (human dependency).",
  };

  mkdirSync(resolve(root, "evidence"), { recursive: true });
  writeFileSync(resolve(root, "evidence/parity.json"), JSON.stringify(parity, null, 2));
  writeFileSync(resolve(root, "evidence/tamper.json"), JSON.stringify(tamperReport, null, 2));
  writeFileSync(resolve(root, "evidence/gas.json"), JSON.stringify(gas, null, 2));
  console.log(`parity: n=${parity.n} mismatches=${mismatches.length}`);
  console.log(`tamper: n=${tamperReport.n} rejected=${rejected} accepted_unexpectedly=${accepted_unexpectedly} (claims>0: ${claims_gt0_accepted}/${claims_gt0}, parity mismatches: ${tamper_parity_mismatches})`);
  console.log(`gas rows:`, JSON.stringify(gasRows));
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
