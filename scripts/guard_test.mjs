#!/usr/bin/env node
// guard_test.mjs — proves the fixture-key paths fail CLOSED: they refuse
// non-loopback endpoints and non-devnode chains BEFORE any signing or
// transaction. Everything here runs against a local mock JSON-RPC; no real
// network, no keys, no signatures.
//
//   node scripts/guard_test.mjs     → exit 0 iff every guard holds

import { spawn } from "node:child_process";
import http from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE =
  "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659";
const OTHER_TEST_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};

// NOTE: must be async — the mock RPC lives in THIS process's event loop, so a
// synchronous spawn would deadlock (parent blocked while child waits on mock).
const run = (script, args, env = {}) =>
  new Promise((res) => {
    const p = spawn("node", [resolve(root, script), ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), 30000);
    p.on("close", (status) => {
      clearTimeout(kill);
      res({ status, output: out });
    });
  });

// a minimal local JSON-RPC that answers eth_chainId with a WRONG chain id
const mockRpc = (chainIdHex) =>
  new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const reqs = JSON.parse(body);
        const list = Array.isArray(reqs) ? reqs : [reqs];
        const out = list.map((r) =>
          r.method === "eth_chainId"
            ? { jsonrpc: "2.0", id: r.id, result: chainIdHex }
            : { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "mock: unimplemented" } },
        );
        rsp.setHeader("content-type", "application/json");
        rsp.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
      });
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });

// 1. parity.mjs against a REMOTE rpc url must refuse before any network call
{
  const r = await run("scripts/parity.mjs", ["--rpc", "https://sepolia-rollup.arbitrum.io/rpc"]);
  check("parity refuses non-loopback RPC", r.status === 1 && /not loopback/.test(r.output));
}
// 2. parity.mjs against a loopback endpoint serving the WRONG chain id
{
  const srv = await mockRpc("0x7a69"); // 31337 — anvil default, not nitro
  const port = srv.address().port;
  const r = await run("scripts/parity.mjs", ["--rpc", `http://127.0.0.1:${port}`]);
  check("parity refuses wrong chain id", r.status === 1 && /chain id 412346, got 31337/.test(r.output));
  srv.close();
}
// 3. parity.mjs against a loopback endpoint serving the RIGHT chain id must
//    pass both guards (it will fail later — no referee deployed — which is
//    expected; we only assert it got PAST the guard stage)
{
  const srv = await mockRpc("0x64aba"); // 412346 = nitro devnode
  const port = srv.address().port;
  const r = await run("scripts/parity.mjs", ["--rpc", `http://127.0.0.1:${port}`]);
  check(
    "parity passes guards on 412346",
    !/refusing to run/.test(r.output) && /mock: unimplemented|Error|error/.test(r.output),
    r.output.split("\n")[0],
  );
  srv.close();
}
// 4. sepolia-evidence.mjs refuses the fixture key outright
{
  const r = await run("scripts/sepolia-evidence.mjs", [], {
    DEPLOYER_KEY: FIXTURE,
    REFEREE_ADDR: "0x525c2aba45f66987217323e8a05ea400c65d06dc",
  });
  check("sepolia script refuses fixture key", r.status === 1 && /fixture key/.test(r.output));
}
// 5. sepolia-evidence.mjs refuses a wrong-chain endpoint before signing
{
  const srv = await mockRpc("0x64aba"); // 412346 — devnode, NOT sepolia
  const port = srv.address().port;
  const r = await run("scripts/sepolia-evidence.mjs", [], {
    DEPLOYER_KEY: OTHER_TEST_KEY,
    REFEREE_ADDR: "0x525c2aba45f66987217323e8a05ea400c65d06dc",
    SEPOLIA_RPC: `http://127.0.0.1:${port}`,
  });
  check(
    "sepolia script refuses non-421614 chain",
    r.status === 1 && /chain id 421614, got 412346/.test(r.output),
  );
  srv.close();
}

console.log(fails ? `\n${fails} GUARD FAILURES` : "\nall fail-closed guards hold");
process.exit(fails ? 1 : 0);
