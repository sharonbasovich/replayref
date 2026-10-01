// Chain access for the LOCAL nitro devnode only. The dev account is the
// public nonsecret fixture OffchainLabs hardcodes in run-dev-node.sh —
// it exists to play with on a throwaway local chain and is useless elsewhere.
import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi,
  decodeErrorResult, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const REFEREE: Address = "0x525c2aba45f66987217323e8a05ea400c65d06dc";
// Same-origin path proxied to the local nitro devnode by vite.config.ts —
// avoids CORS and keeps the browser off any remote endpoint.
export const RPC_URL = "/rpc";

const nitroLocal = defineChain({
  id: 412346, name: "nitro-devnode-local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ABI = parseAbi([
  "function createChallenge(uint64 seed, uint64 startTs, uint64 endTs, address season) returns (uint256)",
  "function verify(uint256 id, bytes inputs) view returns (uint256)",
  "function submit(uint256 id, bytes inputs, uint256 claimedScore) returns (uint256)",
  "function numChallenges() view returns (uint256)",
  "function challengeSeed(uint256 id) view returns (uint64)",
  "function best(uint256 id, address player) view returns (uint256)",
  "function top(uint256 id, uint256 i) view returns (address player, uint256 score)",
  "event ChallengeCreated(uint256 indexed id, uint64 seed, uint64 startTs, uint64 endTs)",
  "event RunAccepted(uint256 indexed id, address indexed player, bytes32 inputsHash, uint256 score)",
  "error BadWindow()",
  "error ChallengeNotFound(uint256 id)",
  "error InvalidInputs()",
  "error ScoreMismatch(uint32 computed)",
  "error NotInWindow(uint64 start, uint64 end, uint64 now)",
]);

export const pub = createPublicClient({ chain: nitroLocal, transport: http(RPC_URL) });
const DEV_KEY = "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659" as Hex;
export const devAccount = privateKeyToAccount(DEV_KEY);
export const wallet = createWalletClient({
  chain: nitroLocal, transport: http(RPC_URL), account: devAccount,
});

export class ChainDown extends Error {}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const NITRO_LOCAL_ID = 412346;

// The bundled fixture key may ONLY sign against the local nitro devnode.
// Fail closed: refuse on a non-local host or a non-devnode chain id BEFORE
// any transaction is constructed — never sweep owner funds with a public key.
export async function assertLocalChain(): Promise<void> {
  if (!LOCAL_HOSTS.includes(location.hostname)) {
    throw new ChainDown("fixture key may only sign from localhost — no transaction sent");
  }
  const id = await pub.getChainId();
  if (id !== NITRO_LOCAL_ID) {
    throw new ChainDown(`fixture key refused: chain id ${id} is not the nitro devnode (${NITRO_LOCAL_ID}) — no transaction sent`);
  }
}

export async function chainAlive(): Promise<boolean> {
  try { await pub.getBlockNumber(); return true; } catch { return false; }
}

export interface VerifyResult {
  ok: boolean;
  score?: bigint;
  errorName?: string;
  errorDetail?: string;
}

export { ABI };

// Guarded wallet write for challenge creation — same fail-closed rule.
export async function createChallengeTx(seed: bigint, start: bigint, end: bigint, season: Address): Promise<`0x${string}`> {
  await assertLocalChain();
  return wallet.writeContract({
    address: REFEREE, abi: ABI, functionName: "createChallenge",
    args: [BigInt.asUintN(64, seed), start, end, season],
  });
}

// probe the node directly — the vite /rpc proxy turns a dead devnode into an
// HTTP 500 that does not look like "fetch failed" or ECONNREFUSED
async function nodeDown(): Promise<boolean> {
  try { await pub.getBlockNumber({ cacheTime: 0 }); return false; } catch { return true; }
}

function decodeRevert(e: any): { name: string; detail?: string } {
  // walk the viem error chain looking for revert data, then decode it
  let cur: any = e;
  while (cur) {
    const d = cur?.data;
    const raw = typeof d === "string" ? d : d?.data ?? d;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
      try {
        const dec = decodeErrorResult({ abi: ABI, data: raw as Hex });
        const arg = dec.args?.[0];
        return {
          name: dec.errorName,
          detail: arg !== undefined ? `${dec.abiItem?.inputs?.[0]?.name ?? "arg"}=${arg}` : undefined,
        };
      } catch { /* undecodable revert blob */ }
    }
    if (d?.errorName) {
      return { name: d.errorName, detail: d.args?.[0] !== undefined ? `computed=${d.args[0]}` : undefined };
    }
    cur = cur.cause;
  }
  return { name: e?.shortMessage?.match(/Error: (\w+)/)?.[1] ?? "revert" };
}

export async function verify(id: bigint, inputs: Hex): Promise<VerifyResult> {
  try {
    const score = await pub.readContract({
      address: REFEREE, abi: ABI, functionName: "verify", args: [id, inputs],
    });
    return { ok: true, score };
  } catch (e: any) {
    if (await nodeDown()) throw new ChainDown("RPC unreachable");
    const { name, detail } = decodeRevert(e);
    return { ok: false, errorName: name, errorDetail: detail };
  }
}

export interface SubmitResult {
  ok: boolean;
  score?: bigint;
  gas?: bigint;
  tx?: string;
  errorName?: string;
  errorDetail?: string;
}

export async function submit(id: bigint, inputs: Hex, claimed: bigint): Promise<SubmitResult> {
  await assertLocalChain();
  try {
    const tx = await wallet.writeContract({
      address: REFEREE, abi: ABI, functionName: "submit", args: [id, inputs, claimed],
    });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status === "reverted") return { ok: false, tx, errorName: "reverted" };
    const score = await pub.readContract({
      address: REFEREE, abi: ABI, functionName: "best", args: [id, devAccount.address],
    });
    return { ok: true, tx, gas: r.gasUsed, score };
  } catch (e: any) {
    if (await nodeDown()) throw new ChainDown("RPC unreachable");
    const { name, detail } = decodeRevert(e);
    return { ok: false, errorName: name, errorDetail: detail };
  }
}

export interface TopRow { player: string; score: bigint }
export async function top(id: bigint): Promise<TopRow[]> {
  const rows: TopRow[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      const [player, score] = await pub.readContract({
        address: REFEREE, abi: ABI, functionName: "top", args: [id, BigInt(i)],
      });
      if (player !== "0x0000000000000000000000000000000000000000") rows.push({ player, score });
    } catch (e) {
      if (await nodeDown()) throw new ChainDown("RPC unreachable");
      break;
    }
  }
  return rows;
}
