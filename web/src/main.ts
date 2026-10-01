import { Core, packLog, bytesToHex, hexToBytes, CHALLENGE_SEED, MAX_INPUT_BYTES } from "./sim";
import * as chain from "./chain";
import type { Hex } from "viem";

const cv = document.getElementById("cv") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const $ = (id: string) => document.getElementById(id)!;

const STATUS = ["FLYING", "LANDED", "CRASHED", "TIMEOUT"];

let core: Core;
let seed = CHALLENGE_SEED;
let actions: number[] = [];
let playing = false;
let replaying = false;
let replayActions: number[] = [];
let keys = { up: false, left: false, right: false };
let touch = { up: false, left: false, right: false };
let lastBytes: Uint8Array | null = null;
let lastScore = 0;
let demoLog: { seed: number; inputs: string; expected_score: number; ticks: number };
let camX = 0;

// IS_LOCAL: served from a dev/preview server on this machine, where the /rpc
// proxy can reach a nitro devnode. Public hosts (GitHub Pages) have no chain.
const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
let chainUp = false;
const chainLabel = () => (chainUp ? "local devnode" : IS_LOCAL ? "no devnode" : "browser only");
const chainDownText = () => IS_LOCAL
  ? "chain: local devnode not running — start nitro-devnode, then this panel verifies for real"
  : "chain: no Arbitrum deployment connected — local WASM verification only, UNVERIFIED";

// ---- challenge resolution: find or lazily create a challenge for a seed ----
const F64ABI = [{ type: "function", name: "challengeSeed", inputs: [{ type: "uint256" }], outputs: [{ type: "uint64" }], stateMutability: "view" }] as const;
const NUMABI = [{ type: "function", name: "numChallenges", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
const CREATEABI = [{ type: "function", name: "createChallenge", inputs: [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" }] as const;
const seedToChallenge = new Map<bigint, bigint>();

async function challengeForSeed(s: bigint): Promise<bigint> {
  const hit = seedToChallenge.get(s);
  if (hit !== undefined) return hit;
  return await createChallengeFor(s);
}

// cached id may point at a pre-restart chain — drop it and rebuild once
async function challengeForSeedFresh(s: bigint): Promise<bigint> {
  seedToChallenge.delete(s);
  return challengeForSeed(s);
}

async function createChallengeFor(s: bigint): Promise<bigint> {
  const n = await chain.pub.readContract({ address: chain.REFEREE, abi: NUMABI, functionName: "numChallenges" });
  for (let i = 0n; i < n; i++) {
    const cs = await chain.pub.readContract({ address: chain.REFEREE, abi: F64ABI, functionName: "challengeSeed", args: [i] });
    seedToChallenge.set(BigInt(cs), i);
    if (BigInt(cs) === s) return i;
  }
  const tx = await chain.createChallengeTx(s, 1n, 4102444800n, "0x0000000000000000000000000000000000000000");
  await chain.pub.waitForTransactionReceipt({ hash: tx });
  // don't assume an index — creation is permissionless; re-scan for OUR seed
  const n2 = await chain.pub.readContract({ address: chain.REFEREE, abi: NUMABI, functionName: "numChallenges" });
  for (let i = 0n; i < n2; i++) {
    const cs = await chain.pub.readContract({ address: chain.REFEREE, abi: F64ABI, functionName: "challengeSeed", args: [i] });
    seedToChallenge.set(BigInt(cs), i);
    if (BigInt(cs) === s) return i;
  }
  throw new Error(`created challenge for seed ${s} not found on chain`);
}

// ---- input ----
function currentAction(): number {
  const u = keys.up || touch.up, l = keys.left || touch.left, r = keys.right || touch.right;
  if (l) return 2;
  if (r) return 3;
  if (u) return 1;
  return 0;
}
addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") keys.up = true;
  if (e.key === "ArrowLeft") keys.left = true;
  if (e.key === "ArrowRight") keys.right = true;
  if (e.key === "r" || e.key === "R") startRun();
});
addEventListener("keyup", (e) => {
  if (e.key === "ArrowUp") keys.up = false;
  if (e.key === "ArrowLeft") keys.left = false;
  if (e.key === "ArrowRight") keys.right = false;
});
const bindTouch = (id: string, k: "up" | "left" | "right") => {
  const el = $(id) as HTMLButtonElement;
  const on = (v: boolean) => (e: Event) => {
    e.preventDefault();
    if (v && e instanceof PointerEvent) el.setPointerCapture?.(e.pointerId);
    touch[k] = v;
  };
  el.addEventListener("pointerdown", on(true));
  el.addEventListener("pointerup", on(false));
  el.addEventListener("pointerleave", on(false));
  el.addEventListener("pointercancel", on(false));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
};
bindTouch("t-up", "up"); bindTouch("t-left", "left"); bindTouch("t-right", "right");

// ---- game loop ----
let raf = 0;
let acc = 0;
let lastT = 0;
function loop(t: number) {
  const dt = Math.min(t - lastT, 100);
  lastT = t;
  acc += dt;
  // fixed 60Hz steps regardless of render rate
  while (acc >= 1000 / 60) {
    acc -= 1000 / 60;
    const st = core.view().status;
    if (st !== 0) { finishRun(); return; }
    const a = replaying ? (replayActions[actions.length] ?? 0) : currentAction();
    core.step(a);
    actions.push(a);
    if (actions.length >= 1800) { finishRun(); return; }
  }
  draw();
  raf = requestAnimationFrame(loop);
}

function startRun() {
  cancelAnimationFrame(raf);
  replaying = false;
  actions = [];
  core.reset(seed);
  playing = true;
  lastBytes = null;
  const vl = $("verdict").querySelector("#v-local")!;
  vl.textContent = "local: —";
  vl.className = "v-local";
  $("v-chain").textContent = chainUp ? "chain: —" : chainDownText();
  $("v-chain").className = "v-chain" + (chainUp ? "" : " warn");
  $("claim-row").classList.add("hidden");
  $("log-info").textContent = "";
  setCheatEnabled(false);
  $("cheat-out").textContent = "";
  $("cheat-out").className = "mono small";
  acc = 0; lastT = performance.now();
  raf = requestAnimationFrame(loop);
}

function startReplay() {
  cancelAnimationFrame(raf);
  replaying = true;
  replayActions = [];
  const bytes = hexToBytes(demoLog.inputs);
  for (const b of bytes) for (let i = 0; i < 8; i += 2) replayActions.push((b >> i) & 3);
  replayActions = replayActions.slice(0, demoLog.ticks);
  seed = BigInt(demoLog.seed);
  actions = [];
  core.reset(seed);
  playing = true;
  lastBytes = null;
  const vl = $("verdict").querySelector("#v-local")!;
  vl.textContent = "local: —";
  vl.className = "v-local";
  $("v-chain").textContent = chainUp ? "chain: —" : chainDownText();
  $("v-chain").className = "v-chain" + (chainUp ? "" : " warn");
  $("claim-row").classList.add("hidden");
  $("log-info").textContent = "";
  setCheatEnabled(false);
  $("cheat-out").textContent = "";
  $("cheat-out").className = "mono small";
  acc = 0; lastT = performance.now();
  raf = requestAnimationFrame(loop);
}

async function finishRun() {
  playing = false;
  cancelAnimationFrame(raf);
  draw();
  const v = core.view();
  lastBytes = packLog(actions);
  const local = core.simulate(seed, lastBytes);
  lastScore = local.score ?? 0;
  const vl = $("v-local");
  vl.textContent = `local: ${STATUS[v.status]} in ${v.t} ticks → score ${local.score ?? `rejected:${local.reject}`}`;
  vl.className = "v-local " + (local.score !== undefined ? "ok" : "bad");
  $("log-info").textContent =
    `input log: ${actions.length} ticks → ${lastBytes.length} bytes (cap ${MAX_INPUT_BYTES}) · hex ${bytesToHex(lastBytes).slice(0, 40)}…`;
  setCheatEnabled(true);
  const claimInput = $("claim") as HTMLInputElement;
  claimInput.value = String(lastScore);
  claimInput.className = "";
  $("claim-row").classList.remove("hidden");
  await chainVerify(lastBytes);
  refreshBoard();
}

const cidFor = (s: bigint) => challengeForSeed(s);
const cid = () => cidFor(seed);

async function chainVerify(bytes: Uint8Array) {
  const vc = $("v-chain");
  vc.textContent = "chain: verifying…";
  vc.className = "v-chain warn";
  try {
    let id = await cid();
    let r = await chain.verify(id, ("0x" + bytesToHex(bytes)) as Hex);
    if (!r.ok && r.errorName === "ChallengeNotFound") {
      id = await challengeForSeedFresh(seed);
      r = await chain.verify(id, ("0x" + bytesToHex(bytes)) as Hex);
    }
    vc.className = "v-chain " + (r.ok ? "ok" : "bad");
    vc.textContent = r.ok
      ? `chain (local devnode): score ${r.score} ✓`
      : `chain (local devnode): rejected — ${r.errorName}${r.errorDetail ? " " + r.errorDetail : ""}`;
    ($("btn-submit") as HTMLButtonElement).disabled = false;
  } catch {
    chainUp = false;
    vc.className = "v-chain warn";
    vc.textContent = chainDownText();
    ($("btn-submit") as HTMLButtonElement).disabled = true;
  }
}

function setCheatEnabled(on: boolean) {
  ["cheat-score", "cheat-byte", "cheat-seed"].forEach((id) =>
    (($(id) as HTMLButtonElement).disabled = !on));
}

async function cheat(kind: "score" | "byte" | "seed") {
  const out = $("cheat-out");
  if (!lastBytes) return;
  out.className = "mono small";
  try {
    if (kind === "score") {
      const claim = BigInt(lastScore) + 500n;
      const r = await chain.submit(await cid(), ("0x" + bytesToHex(lastBytes)) as Hex, claim);
      out.className = "mono small bad";
      out.textContent = r.ok
        ? `unexpected: chain accepted claim ${claim}`
        : `REJECTED — ${r.errorName}${r.errorDetail ? " (" + r.errorDetail + ")" : ""}\nchain recomputed the real score; the +500 lie never landed.`;
    } else if (kind === "byte") {
      const b = Uint8Array.from(lastBytes);
      const i = Math.min(b.length - 1, Math.max(0, Math.floor(b.length / 2)));
      b[i] ^= 0x01;
      const r = await chain.verify(await cid(), ("0x" + bytesToHex(b)) as Hex);
      out.className = "mono small bad";
      out.textContent = r.ok
        ? `chain re-simulated the edited log → score ${r.score} (your claim said ${lastScore})\nedit detected: replay diverges from the claim.`
        : `REJECTED — ${r.errorName}${r.errorDetail ? " " + r.errorDetail : ""}`;
    } else {
      // verify this log under a DIFFERENT seed's challenge — score should differ
      const r = await chain.verify(await cidFor(seed + 1n), ("0x" + bytesToHex(lastBytes)) as Hex);
      out.className = "mono small bad";
      out.textContent = r.ok
        ? `same log, wrong seed → chain computed ${r.score}, not ${lastScore}
the run only verifies under the seed it was played on.`
        : `REJECTED — ${r.errorName}${r.errorDetail ? " " + r.errorDetail : ""}`;
    }
  } catch {
    out.textContent = IS_LOCAL
      ? "chain unreachable — restart the local devnode"
      : "no Arbitrum deployment connected — the cheat rejection demo needs a local devnode";
    out.className = "mono small warn";
  }
}

async function submitScore() {
  const claim = BigInt(($("claim") as HTMLInputElement).value || "0");
  const out = $("v-chain");
  if (!lastBytes) return;
  try {
    const r = await chain.submit(await cid(), ("0x" + bytesToHex(lastBytes)) as Hex, claim);
    out.className = "v-chain " + (r.ok ? "ok" : "bad");
    out.textContent = r.ok
      ? `chain: ACCEPTED score ${r.score} — gas ${r.gas} (local devnode tx ${r.tx!.slice(0, 18)}…)`
      : `chain: REJECTED — ${r.errorName}${r.errorDetail ? " (" + r.errorDetail + ")" : ""}`;
    refreshBoard();
  } catch {
    out.className = "v-chain warn";
    out.textContent = chainDownText();
    ($("btn-submit") as HTMLButtonElement).disabled = true;
  }
}

async function refreshBoard() {
  try {
    const rows = await chain.top(await cidFor(CHALLENGE_SEED));
    $("board").innerHTML = rows.length
      ? rows.map((r, i) => `#${i + 1} ${r.player.slice(0, 8)}… ${r.score}`).join("<br>")
      : "empty — nobody has landed yet";
  } catch {
    $("board").textContent = IS_LOCAL ? "chain unreachable" : "no chain connected — local demo only";
  }
}

// ---- rendering ----
const SC = 0.42; // world px -> canvas px
function draw() {
  const v = core.view();
  camX = Math.max(0, Math.min(2048 - cv.width / SC, v.x_px - cv.width / SC / 2));
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(SC, SC);
  ctx.translate(-camX, 0);
  // flip y: world y up, canvas y down. Map world 0..1400 onto canvas height/SC.
  const H = cv.height / SC;
  const wy = (y: number) => H - y;

  // stars
  ctx.fillStyle = "#1b2340";
  for (let i = 0; i < 60; i++) {
    const sx = (i * 733) % 2048, sy = (i * 389) % (H - 300);
    ctx.fillRect(sx, sy * 0.6, 3, 3);
  }

  // terrain
  const ter = core.terrain(seed);
  const pad = core.padSegment(seed);
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= 2048; x += 16) ctx.lineTo(x, wy(core.groundAt(seed, x)));
  ctx.lineTo(2048, H);
  ctx.closePath();
  ctx.fillStyle = "#131a30";
  ctx.fill();
  ctx.strokeStyle = "#3d4a78";
  ctx.lineWidth = 4;
  ctx.stroke();

  // pad highlight
  const x0 = pad * (2048 / 24), x1 = (pad + 1) * (2048 / 24);
  const h = ter[pad];
  ctx.strokeStyle = "#f5c54b";
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(x0 + 8, wy(h)); ctx.lineTo(x1 - 8, wy(h)); ctx.stroke();
  ctx.fillStyle = "#f5c54b";
  ctx.font = "44px monospace";
  ctx.fillText("PAD", x0 + (x1 - x0) / 2 - 40, wy(h) - 18);

  // ship
  ctx.save();
  ctx.translate(v.x_px, wy(v.y_px));
  ctx.rotate(-v.rot_deg * Math.PI / 180);
  ctx.fillStyle = v.status === 1 ? "#4ade80" : v.status === 2 ? "#f87171" : "#dfe6ff";
  ctx.beginPath();
  ctx.moveTo(0, -26); ctx.lineTo(-18, 16); ctx.lineTo(-6, 10); ctx.lineTo(6, 10); ctx.lineTo(18, 16);
  ctx.closePath(); ctx.fill();
  // thrust flame
  if (playing && (actions[actions.length - 1] === 1) && v.status === 0) {
    ctx.fillStyle = "#ff9a3d";
    ctx.beginPath(); ctx.moveTo(-8, 16); ctx.lineTo(0, 44); ctx.lineTo(8, 16); ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // challenge label
  ctx.fillStyle = "#8b93b8";
  ctx.font = "28px monospace";
  ctx.fillText(`seed ${seed} (${chainLabel()})`, camX + 24, 48);

  ctx.restore();

  // hud
  $("hud-status").textContent = STATUS[v.status] + (replaying ? " (verified replay)" : "");
  $("hud-fuel").textContent = `fuel ${v.fuel}/900`;
  $("hud-ticks").textContent = `t ${v.t}/1800`;
  $("hud-vel").textContent = `vx ${v.vx} vy ${v.vy} rot ${v.rot_deg}°`;
}

// ---- boot ----
async function main() {
  core = await Core.load(import.meta.env.BASE_URL + "ref_core.wasm");
  demoLog = await (await fetch(import.meta.env.BASE_URL + "demo_log.json")).json();
  $("btn-reset").onclick = startRun;
  $("btn-newseed").onclick = () => {
    seed = BigInt(Math.floor(Math.random() * 2 ** 40));
    startRun();
  };
  $("btn-replay").onclick = startReplay;
  $("btn-submit").onclick = submitScore;
  $("cheat-score").onclick = () => cheat("score");
  $("cheat-byte").onclick = () => cheat("byte");
  $("cheat-seed").onclick = () => cheat("seed");
  // only probe the chain when the /rpc proxy can exist (local dev/preview);
  // a public host has no node behind it — skip the pointless request
  chainUp = IS_LOCAL ? await chain.chainAlive() : false;
  const banner = $("env-banner");
  if (chainUp) {
    banner.textContent = "LOCAL SIMULATION — Arbitrum nitro devnode on this machine (chain 412346). Nothing here is a public chain.";
  } else if (IS_LOCAL) {
    banner.textContent = "LOCAL SIMULATION — nitro devnode not running; start it for chain verification.";
    $("v-chain").textContent = chainDownText();
    $("v-chain").className = "v-chain warn";
    ($("btn-submit") as HTMLButtonElement).disabled = true;
  } else {
    banner.textContent = "PUBLIC DEMO — game + verified replay run in your browser with local WASM verification. No Arbitrum deployment is connected.";
    $("v-chain").textContent = chainDownText();
    $("v-chain").className = "v-chain warn";
    ($("btn-submit") as HTMLButtonElement).disabled = true;
    ($("board-lbl") as HTMLElement).textContent = "no chain";
  }
  refreshBoard();
  startRun();
}
main();
