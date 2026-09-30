#!/usr/bin/env node
// differential.mjs — runs tests/corpus/valid.jsonl through the wasm build of
// ref-core and diffs every outcome against the native build (replaysim corpus).
// Writes evidence/differential.json. Exit 1 on any mismatch.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = process.argv[2] || "tests/corpus/valid.jsonl";
const outPath = process.argv[3] || "evidence/differential.json";

const wasmPath = resolve(root, "target/wasm32-unknown-unknown/release/wasm_abi.wasm");
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const mem = new Uint8Array(ex.memory.buffer);
const outView = new DataView(ex.memory.buffer, ex.out_ptr(), 16);

const lines = readFileSync(resolve(root, corpusPath), "utf8").trim().split("\n");
const entries = lines.map((l) => JSON.parse(l));

// native side
const nativeOut = execFileSync(resolve(root, "target/release/replaysim"), ["corpus", resolve(root, corpusPath)], {
  maxBuffer: 1 << 28,
}).toString();
const native = new Map();
for (const l of nativeOut.trim().split("\n")) {
  const r = JSON.parse(l);
  native.set(r.id, r.result);
}

const STATUS = ["running", "landed", "crashed", "timeout"];
let n = 0;
let mismatches = [];
for (const e of entries) {
  const inputBytes = Buffer.from(e.inputs, "hex");
  const ptr = ex.input_ptr();
  mem.set(inputBytes.subarray(0, ex.input_capacity()), ptr);
  const seed = BigInt(e.seed);
  const rc = ex.simulate_log(Number(seed & 0xffffffffn), Number((seed >> 32n) & 0xffffffffn), inputBytes.length);
  const wasmResult =
    rc === 1 ? { reject: "too_long" }
    : rc === 2 ? { reject: "nonzero_trailer" }
    : {
        status: STATUS[outView.getUint32(12, true)],
        ticks: outView.getUint32(4, true),
        fuel_left: outView.getUint32(8, true),
        score: outView.getUint32(0, true),
      };
  const nat = native.get(e.id);
  n++;
  if (JSON.stringify(wasmResult) !== JSON.stringify(nat)) {
    mismatches.push({ id: e.id, seed: e.seed.toString(), wasm: wasmResult, native: nat });
  }
}

const report = {
  generated_at: new Date().toISOString(),
  corpus: corpusPath,
  wasm: "target/wasm32-unknown-unknown/release/wasm_abi.wasm",
  n,
  mismatches: mismatches.length,
  mismatch_samples: mismatches.slice(0, 20),
};
mkdirSync(resolve(root, dirname(outPath)), { recursive: true });
writeFileSync(resolve(root, outPath), JSON.stringify(report, null, 2));
console.log(`n=${n} mismatches=${mismatches.length}`);
process.exit(mismatches.length ? 1 : 0);
