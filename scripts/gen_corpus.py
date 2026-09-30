#!/usr/bin/env python3
"""gen_corpus.py — independent corpus generator for ReplayRef.

Written before the referee contract exists. The corpus seeds below are frozen
constants committed to git BEFORE the contract implementation lands, so the
held-out tamper corpus is genuinely held-out (git history is the proof).

Uses its own RNG (splitmix64 — deliberately NOT the sim's xorshift64*) and
knows nothing about the physics. Autopilot logs come from `replaysim`'s
separate `autopilot` bin via subprocess.

Usage:
    python3 scripts/gen_corpus.py [--replaysim ./core/target/release/replaysim \
                                    --autopilot ./core/target/release/autopilot]
Outputs:
    tests/corpus/valid.jsonl   - 1200 logs: {id, seed, inputs}
    tests/corpus/tamper.jsonl  - tampered/forged variants:
                                 {id, base_id, mutation, seed, inputs, claim_offset}
"""

import json
import random
import subprocess
import sys
import os

# Frozen constants — DO NOT EDIT after first commit. These fix the corpora.
VALID_SEED = 0xB16B00B5
TAMPER_SEED = 0xDEADBEEF42
N_VALID = 1200
N_AUTOPILOT = 200          # autopilot seeds attempted; landers + crashes kept
MAX_BYTES = 450


def splitmix_stream(seed):
    s = seed & 0xFFFFFFFFFFFFFFFF
    while True:
        s = (s + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        z = s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        yield z ^ (z >> 31)


def rand_log(rng, kind):
    """One input log as bytes. kind: 'random' | 'bursts' | 'idle_tail'."""
    if kind == "random":
        n = rng.randrange(0, MAX_BYTES + 1)
        return bytes(rng.randrange(256) for _ in range(n))
    if kind == "bursts":
        # plausible pilot-ish stream: runs of thrust, corrections, pauses
        actions = []
        while len(actions) < rng.randrange(60, 900):
            run = rng.randrange(1, 12)
            a = rng.choice([0, 0, 1, 1, 1, 2, 3])
            actions.extend([a] * run)
        out = bytearray()
        for i in range(0, len(actions), 4):
            b = 0
            for j, a in enumerate(actions[i:i + 4]):
                b |= (a & 3) << (2 * j)
            out.append(b)
        return bytes(out)
    # idle_tail: short active prefix then long zero tail
    n = rng.randrange(4, 60)
    log = bytearray(rng.randrange(256) for _ in range(n))
    log.extend(b"\x00" * rng.randrange(10, 80))
    return bytes(log[:MAX_BYTES])


def main():
    autopilot_bin = os.environ.get("AUTOPILOT", "./core/target/release/autopilot")
    rng = random.Random(VALID_SEED)

    valid = []
    # ~60% burst-pattern logs, ~25% pure random, 15% idle-tail
    for i in range(N_VALID - N_AUTOPILOT):
        kind = rng.choices(["random", "bursts", "idle_tail"], weights=[25, 60, 15])[0]
        seed = rng.getrandbits(63)
        valid.append({"id": f"v{i:04d}", "seed": str(seed),
                      "inputs": rand_log(rng, kind).hex()})

    # autopilot logs: real landings where the controller manages it
    ap_ok = 0
    for i in range(N_AUTOPILOT):
        seed = rng.getrandbits(63)
        try:
            out = subprocess.run([autopilot_bin, str(seed)], capture_output=True,
                                 text=True, timeout=20)
            rec = json.loads(out.stdout.strip())
            valid.append({"id": f"a{i:04d}", "seed": str(seed), "inputs": rec["inputs"]})
            if rec["status"] == "landed":
                ap_ok += 1
        except Exception as e:
            print(f"autopilot seed {seed} failed: {e}", file=sys.stderr)
    print(f"autopilot: {ap_ok}/{N_AUTOPILOT} landed", file=sys.stderr)

    os.makedirs("tests/corpus", exist_ok=True)
    with open("tests/corpus/valid.jsonl", "w") as f:
        for r in valid:
            f.write(json.dumps(r) + "\n")

    # ---- held-out tamper corpus (frozen seed, generated from valid base) ----
    trng = random.Random(TAMPER_SEED)
    tamper = []
    # pick a fixed pseudo-random subset of the valid corpus as bases
    bases = trng.sample(valid, 400)
    mut = 0
    for b in bases:
        raw = bytearray.fromhex(b["inputs"])
        seed = int(b["seed"])

        def add(mutation, data, claim_offset=0, seed_override=None):
            nonlocal_mut = {"i": 0}
            tamper.append({
                "id": f"t{len(tamper):05d}",
                "base_id": b["id"],
                "mutation": mutation,
                "seed": str(seed if seed_override is None else seed_override),
                "inputs": bytes(data).hex(),
                "claim_offset": claim_offset,
            })

        # 1. flip one random bit
        if raw:
            d = bytearray(raw)
            i = trng.randrange(len(d))
            d[i] ^= 1 << trng.randrange(8)
            add("flip_bit", d)
        # 2. truncate
        if len(raw) > 4:
            add("truncate", raw[: trng.randrange(1, len(raw) - 1)])
        # 3. overlong — always exceeds the 450-byte cap
        add("overlong", bytes(raw) + bytes(460 - len(raw)))
        # 4. claimed score +1 (log untouched)
        add("claim_plus1", raw, claim_offset=1)
        # 5. replay under a different seed
        add("wrong_seed", raw, seed_override=(seed ^ 0x5EED5EED) & 0xFFFFFFFFFFFFFFFF)
        # 6. non-zero padding appended after a short log
        add("nonzero_pad", bytes(raw) + bytes([0xFF, 0xFF, 0x01, 0x55]))
        mut += 1

    with open("tests/corpus/tamper.jsonl", "w") as f:
        for r in tamper:
            f.write(json.dumps(r) + "\n")

    print(f"wrote {len(valid)} valid, {len(tamper)} tamper entries", file=sys.stderr)


if __name__ == "__main__":
    main()
