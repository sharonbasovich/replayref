//! ref-core — deterministic, integer-only lunar-lander simulation.
//!
//! The same code is compiled three ways:
//!   1. native Rust (tests + corpus tooling)
//!   2. wasm32 for the browser game (raw ABI, no wasm-bindgen)
//!   3. wasm32 inside the Stylus referee contract
//!
//! Rules of the house: integers only (Q16.16 fixed point), no clocks, no
//! randomness besides the seeded xorshift64* below, no allocation that grows
//! with the input, and every arithmetic op is chosen so that an int64 Solidity
//! port produces bit-identical results (truncating division, wrapping mul).

#![no_std]

pub type Fp = i64; // Q16.16 fixed point

pub const FP_ONE: Fp = 1 << 16;
pub const TICKS_PER_SECOND: u32 = 60;
pub const MAX_TICKS: u32 = 1800; // 30 simulated seconds
pub const MAX_INPUT_BYTES: usize = (MAX_TICKS as usize) / 4; // 450

pub const WORLD_W: i64 = 2048; // world width in px (integer space)
pub const WORLD_W_FP: Fp = WORLD_W << 16;
pub const CEILING_FP: Fp = 1400 << 16;
pub const SEGMENTS: u32 = 24;
pub const SEG_W_FP: Fp = WORLD_W_FP / SEGMENTS as i64;

pub const FUEL_MAX: u32 = 900; // ticks of thrust
pub const GRAVITY: Fp = 1100; // fp px/tick^2
pub const THRUST: Fp = 2600;
pub const ROT_STEP: i32 = 3; // degrees per tick
pub const LAND_MAX_VX: Fp = 52428; // 0.8 px/tick
pub const LAND_MAX_VY: Fp = 78643; // 1.2 px/tick downward
pub const LAND_MAX_ROT: i32 = 12; // degrees from upright

const SEED_MIX: u64 = 0x9E37_79B9_7F4A_7C15;
const XS64_MULT: u64 = 2_685_821_657_736_338_717;

/// xorshift64* — exact op order mirrors the Solidity port.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ SEED_MIX)
    }
    pub fn next(&mut self) -> u64 {
        let mut s = self.0;
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        self.0 = s;
        s.wrapping_mul(XS64_MULT)
    }
}

/// Bhaskara I sine approximation for degrees in [0, 180], Q16.16 out.
/// Integer-only and error-symmetric, so every port can reproduce it exactly.
fn sin_0_180(deg: i64) -> Fp {
    let n = 4 * deg * (180 - deg);
    let d = 40500 - deg * (180 - deg);
    (n << 16) / d
}

/// sin(deg) for any integer degree, Q16.16.
pub fn sin_deg(deg: i32) -> Fp {
    let d = (deg.rem_euclid(360)) as i64;
    if d <= 180 {
        sin_0_180(d)
    } else {
        -sin_0_180(d - 180)
    }
}

pub fn cos_deg(deg: i32) -> Fp {
    sin_deg(deg + 90)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Running,
    Landed,
    Crashed,
    Timeout,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    TooLong,
    NonZeroTrailer,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Outcome {
    pub status: Status,
    pub ticks: u32,
    pub fuel_left: u32,
    pub score: u32,
}

/// Per-tick action: 0 idle, 1 thrust, 2 rotate-left, 3 rotate-right.
#[inline]
pub fn action_at(inputs: &[u8], tick: u32) -> u8 {
    let idx = (tick / 4) as usize;
    if idx >= inputs.len() {
        return 0;
    }
    (inputs[idx] >> (2 * (tick % 4))) & 0x3
}

/// Terrain control heights (Q16.16) and the landing-pad segment index.
/// Draw order is contractual — every port consumes the rng identically.
pub fn terrain(seed: u64) -> ([i64; (SEGMENTS + 1) as usize], u32, i64) {
    let mut rng = Rng::new(seed);
    let mut h = [0i64; (SEGMENTS + 1) as usize];
    let mut i = 0usize;
    while i <= SEGMENTS as usize {
        h[i] = ((40 + (rng.next() % 160)) as i64) << 16;
        i += 1;
    }
    let pad_seg = (rng.next() % SEGMENTS as u64) as u32;
    let pad_h = ((24 + (rng.next() % 24)) as i64) << 16;
    h[pad_seg as usize] = pad_h;
    h[pad_seg as usize + 1] = pad_h;
    (h, pad_seg, pad_h)
}

/// Ground height (Q16.16) at x (Q16.16). x is clamped to [0, WORLD_W).
pub fn ground_at(h: &[i64; (SEGMENTS + 1) as usize], x: Fp) -> Fp {
    let xc = if x < 0 {
        0
    } else if x > WORLD_W_FP - 1 {
        WORLD_W_FP - 1
    } else {
        x
    };
    let seg = (xc / SEG_W_FP).min((SEGMENTS - 1) as i64) as usize;
    let t = ((xc - seg as i64 * SEG_W_FP) << 16) / SEG_W_FP; // 0..FP_ONE
    h[seg] + ((h[seg + 1] - h[seg]) * t) / FP_ONE
}

/// Starting position draws come after the terrain draws — fixed order.
pub fn start_state(seed: u64) -> (Fp, Fp) {
    let mut rng = Rng::new(seed);
    let mut i = 0;
    while i <= SEGMENTS {
        let _ = rng.next();
        i += 1;
    }
    let _ = rng.next(); // pad_seg
    let _ = rng.next(); // pad_h
    let x0 = ((200 + (rng.next() % (WORLD_W as u64 - 400))) as i64) << 16;
    let y0 = (700i64) << 16;
    (x0, y0)
}

fn trailer_is_zero(inputs: &[u8], used_ticks: u32) -> bool {
    let byte_idx = (used_ticks / 4) as usize;
    let bit_off = 2 * (used_ticks % 4);
    let mut i = byte_idx;
    while i < inputs.len() {
        let b = if i == byte_idx {
            inputs[i] >> bit_off // consumed low bits may be nonzero; rest must be 0
        } else {
            inputs[i]
        };
        if b != 0 {
            return false;
        }
        i += 1;
    }
    true
}

/// One-tick integrator state. The browser's live rendering drives `step()`
/// directly, so the picture on screen is the exact run the referee scores.
pub struct Sim {
    pub x: Fp,
    pub y: Fp,
    pub vx: Fp,
    pub vy: Fp,
    pub rot: i32,
    pub fuel: u32,
    pub t: u32,
    pub status: Status,
    terrain_h: [i64; (SEGMENTS + 1) as usize],
    pad_lo: Fp,
    pad_hi: Fp,
}

impl Sim {
    pub fn new(seed: u64) -> Self {
        let (h, pad_seg, _) = terrain(seed);
        let (x, y) = start_state(seed);
        Sim {
            x,
            y,
            vx: 0,
            vy: 0,
            rot: 0,
            fuel: FUEL_MAX,
            t: 0,
            status: Status::Running,
            terrain_h: h,
            pad_lo: pad_seg as i64 * SEG_W_FP,
            pad_hi: (pad_seg as i64 + 1) * SEG_W_FP,
        }
    }

    pub fn pad_range(&self) -> (Fp, Fp) {
        (self.pad_lo, self.pad_hi)
    }

    pub fn ground(&self, x: Fp) -> Fp {
        ground_at(&self.terrain_h, x)
    }

    /// Advance one tick with `action` (0..3). No-op once finished or past MAX_TICKS.
    pub fn step(&mut self, action: u8) -> Status {
        if self.status != Status::Running || self.t >= MAX_TICKS {
            if self.t >= MAX_TICKS && self.status == Status::Running {
                self.status = Status::Timeout;
            }
            return self.status;
        }
        let a = action & 0x3;
        match a {
            2 => self.rot -= ROT_STEP,
            3 => self.rot += ROT_STEP,
            _ => {}
        }
        self.rot = self.rot.rem_euclid(360);
        let mut ax: Fp = 0;
        let mut ay: Fp = 0;
        if a == 1 && self.fuel > 0 {
            self.fuel -= 1;
            ax = (sin_deg(self.rot) * THRUST) / FP_ONE;
            ay = (cos_deg(self.rot) * THRUST) / FP_ONE;
        }
        self.vy -= GRAVITY;
        self.vx += ax;
        self.vy += ay;
        self.x += self.vx;
        self.y += self.vy;
        self.t += 1;

        if self.x < 0 || self.x > WORLD_W_FP {
            self.status = Status::Crashed;
            return self.status;
        }
        if self.y >= CEILING_FP {
            self.y = CEILING_FP;
            if self.vy > 0 {
                self.vy = 0;
            }
        }
        let g = self.ground(self.x);
        if self.y <= g {
            let on_pad = self.x >= self.pad_lo && self.x <= self.pad_hi;
            let rot_signed = if self.rot > 180 { self.rot - 360 } else { self.rot };
            if on_pad
                && self.vx.abs() <= LAND_MAX_VX
                && self.vy >= -LAND_MAX_VY
                && rot_signed.abs() <= LAND_MAX_ROT
            {
                self.status = Status::Landed;
            } else {
                self.status = Status::Crashed;
            }
            return self.status;
        }
        if self.t >= MAX_TICKS {
            self.status = Status::Timeout;
        }
        self.status
    }

    pub fn score(&self) -> u32 {
        if self.status == Status::Landed {
            10_000 + self.fuel * 3 + (MAX_TICKS - self.t)
        } else {
            0
        }
    }
}

/// The single source of truth. Pure function of (seed, inputs).
pub fn simulate(seed: u64, inputs: &[u8]) -> Result<Outcome, Reject> {
    if inputs.len() > MAX_INPUT_BYTES {
        return Err(Reject::TooLong);
    }
    let mut sim = Sim::new(seed);
    while sim.status == Status::Running {
        sim.step(action_at(inputs, sim.t));
    }
    if !trailer_is_zero(inputs, sim.t) {
        return Err(Reject::NonZeroTrailer);
    }
    Ok(Outcome {
        status: sim.status,
        ticks: sim.t,
        fuel_left: sim.fuel,
        score: sim.score(),
    })
}

/// Score for a seed+log without the Outcome wrapper — what the contract returns.
pub fn score_of(seed: u64, inputs: &[u8]) -> Result<u32, Reject> {
    simulate(seed, inputs).map(|o| o.score)
}
