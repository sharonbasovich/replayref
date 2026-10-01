#!/usr/bin/env node
// wasm_smoke.mjs — boundary regressions on the BROWSER wasm module
// (web/public/ref_core.wasm). Catches ABI drift between the raw exports and
// what main.ts/sim.ts assume. No chain, no keys.
//
//   node scripts/wasm_smoke.mjs [path-to-wasm]   (default web/public/ref_core.wasm)
//
// Exits non-zero on any failure.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmFile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "web/public/ref_core.wasm");
const bytes = readFileSync(wasmFile);
const { instance } = await WebAssembly.instantiate(bytes);
const x = instance.exports;

const lo = (s) => Number(s & 0xffffffffn);
const hi = (s) => Number((s >> 32n) & 0xffffffffn);
const SEED = 7777777n;

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};

// 1. terrain_h_at is Q16.16 — callers must shift 16. Pad height in px must be
//    inside the drawable world (the cb9ca39 bug treated raw fp as px → pad
//    drew at ~2.5M px, off-canvas).
const pad = x.pad_segment(lo(SEED), hi(SEED));
const padHfp = x.terrain_h_at(lo(SEED), hi(SEED), pad);
const padHpx = Number(padHfp >> 16n);
check("pad control height converts to drawable px", padHpx > 0 && padHpx < 1400, `seg ${pad} → ${padHpx}px (raw ${padHfp})`);
const midX = Math.floor((pad * 2048) / 24) + 40;
const groundAtPad = Number(x.ground_px(lo(SEED), hi(SEED), midX));
check("pad height matches ground_px near pad", Math.abs(groundAtPad - padHpx) <= 2, `ground ${groundAtPad} vs pad ${padHpx}`);

// 2. simulate_log must REJECT len > 450 like ref-core and the contract —
//    never truncate (P3-1: WASM used to clamp to 450 while native rejected).
const cap = x.input_capacity();
const buf = new Uint8Array(x.memory.buffer, x.input_ptr(), cap);
buf.fill(0);
for (const len of [450, 451, 512, 4096]) {
  const rc = x.simulate_log(lo(SEED), hi(SEED), len);
  const want = len > cap ? 1 : 0; // rc 1 = TooLong
  check(`simulate_log len=${len} rc=${rc} (want ${want})`, rc === want);
}

// 3. A valid replay still verifies through the wasm path (demo log).
const demo = JSON.parse(readFileSync(resolve(root, "web/public/demo_log.json"), "utf8"));
const inBytes = Buffer.from(demo.inputs, "hex");
buf.fill(0); buf.set(inBytes);
const rc = x.simulate_log(lo(BigInt(demo.seed)), hi(BigInt(demo.seed)), inBytes.length);
const out = new Int32Array(x.memory.buffer, x.out_ptr(), 4);
check("demo log verifies through wasm", rc === 0 && out[0] === demo.expected_score, `rc ${rc} score ${out[0]} want ${demo.expected_score}`);

console.log(fails ? `\n${fails} FAILURES` : "\nall boundary checks pass");
process.exit(fails ? 1 : 0);
