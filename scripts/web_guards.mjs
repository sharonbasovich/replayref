#!/usr/bin/env node
// web_guards.mjs — static regression checks on web/src/main.ts. These are
// SOURCE-LEVEL assertions only: they verify the fail-closed guards that were
// found missing in review are still present in the code. They do not run the
// browser (that's what manual/QA verification is for).
//
//   node scripts/web_guards.mjs   → exit 0 iff every guard pattern is present

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(root, "web/src/main.ts"), "utf8");

const inBody = (fn, needle) => {
  const i = src.indexOf(`function ${fn}`);
  const j = src.indexOf("\nfunction ", i + 1);
  const body = src.slice(i, j < 0 ? src.length : j);
  return body.includes(needle);
};

let fails = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) fails++;
};

// 1. every chain-touching UI path must bail on !chainUp (hosted = zero RPC)
check("refreshBoard gated on !chainUp", inBody("refreshBoard", "if (!chainUp)"));
check("chainVerify gated on !chainUp", inBody("chainVerify", "if (!chainUp)"));
check("cheat gated on !chainUp", inBody("cheat", "if (!chainUp)"));

// 2. scroll guard: preventDefault only while playing, never on editable targets
check("scroll guard requires playing", src.includes("playing && !isEditable(e.target)"));
check("editable exemption exists", src.includes("isContentEditable"));
// Space on a focused interactive element must NOT be preventDefaulted
check("space-on-interactive exemption", src.includes('e.key === " " && interactive'));

// 3. favicon wired up
const html = readFileSync(resolve(root, "web/index.html"), "utf8");
check("favicon link present", /rel="icon"[^>]*favicon/.test(html));

console.log(fails ? `\n${fails} WEB-GUARD FAILURES` : "\nall web guards present");
process.exit(fails ? 1 : 0);
