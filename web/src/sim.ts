// Wrapper over ref_core.wasm — the same stepper the chain runs. One input
// per tick: 0 idle, 1 thrust, 2 rotate-left, 3 rotate-right.
export const MAX_INPUT_BYTES = 450;
export const CHALLENGE_SEED = 7777777n;

export interface WasmExports {
  input_ptr(): number;
  input_capacity(): number;
  out_ptr(): number;
  view_ptr(): number;
  simulate_log(seed_lo: number, seed_hi: number, len: number): number;
  game_reset(seed_lo: number, seed_hi: number): number;
  game_step(action: number): number;
  pad_segment(seed_lo: number, seed_hi: number): number;
  terrain_h_at(seed_lo: number, seed_hi: number, i: number): bigint;
  ground_px(seed_lo: number, seed_hi: number, x_px: number): bigint;
  start_x_px(seed_lo: number, seed_hi: number): bigint;
  memory: WebAssembly.Memory;
}

export interface SimView {
  status: number; // 0 flying 1 landed 2 crashed 3 timeout
  t: number;
  x_px: number; y_px: number;
  vx: number; vy: number; // integer px/tick (fp >> 16)
  rot_deg: number; fuel: number; score: number;
}

const lo = (s: bigint) => Number(s & 0xffffffffn);
const hi = (s: bigint) => Number((s >> 32n) & 0xffffffffn);

export class Core {
  private x: WasmExports;
  constructor(x: WasmExports) { this.x = x; }

  static async load(url: string): Promise<Core> {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url));
    return new Core(instance.exports as unknown as WasmExports);
  }

  reset(seed: bigint) { this.x.game_reset(lo(seed), hi(seed)); }
  step(action: number) { return this.x.game_step(action); }

  // VIEW layout: x,y (px ints), vx,vy (px/tick ints), rot, fuel, t, status, score
  view(): SimView {
    const v = new Int32Array(this.x.memory.buffer, this.x.view_ptr(), 9);
    return {
      x_px: v[0], y_px: v[1], vx: v[2], vy: v[3],
      rot_deg: v[4], fuel: v[5], t: v[6], status: v[7], score: v[8],
    };
  }

  terrain(seed: bigint): number[] {
    // terrain_h_at returns Q16.16 fixed-point — shift to integer px
    return Array.from({ length: 25 }, (_, i) =>
      Number(this.x.terrain_h_at(lo(seed), hi(seed), i) >> 16n));
  }
  padSegment(seed: bigint): number { return this.x.pad_segment(lo(seed), hi(seed)); }
  groundAt(seed: bigint, xPx: number): number { return Number(this.x.ground_px(lo(seed), hi(seed), xPx)); }
  startX(seed: bigint): number { return Number(this.x.start_x_px(lo(seed), hi(seed))); }

  // Authoritative full-log recompute — same function the Stylus referee runs.
  simulate(seed: bigint, bytes: Uint8Array): { score?: number; reject?: string; ticks?: number } {
    const cap = this.x.input_capacity();
    const buf = new Uint8Array(this.x.memory.buffer, this.x.input_ptr(), cap);
    buf.fill(0);
    buf.set(bytes.slice(0, cap));
    const rc = this.x.simulate_log(lo(seed), hi(seed), bytes.length);
    if (rc !== 0) return { reject: rc === 1 ? "TooLong" : "NonZeroTrailer" };
    const out = new Int32Array(this.x.memory.buffer, this.x.out_ptr(), 4);
    return { score: out[0], ticks: out[1] };
  }
}

// hex <-> bytes helpers for the packed 2-bit log
export const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// pack actions into the contract's 2-bit-per-tick format (tick 0 = low bits)
export function packLog(actions: number[]): Uint8Array {
  const n = Math.ceil(actions.length / 4);
  const b = new Uint8Array(n);
  for (let i = 0; i < actions.length; i++)
    b[i >> 2] |= (actions[i] & 3) << ((i & 3) * 2);
  return b;
}
