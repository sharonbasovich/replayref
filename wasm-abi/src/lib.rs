//! wasm-abi — raw WASM ABI for the browser game. No wasm-bindgen: a static
//! input buffer, a static Sim, and static out-structs keep the module
//! allocator-free and small.

#![no_std]

use ref_core::*;

static mut IN_BUF: [u8; MAX_INPUT_BYTES] = [0; MAX_INPUT_BYTES];
// score, ticks, fuel, status(0 run/1 land/2 crash/3 timeout)
static mut OUT: [u32; 4] = [0; 4];
// live render view: x,y,vx,vy (px ints), rot, fuel, t, status, score
static mut VIEW: [i32; 9] = [0; 9];
static mut SIM: Option<Sim> = None;

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    unsafe { IN_BUF.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn input_capacity() -> u32 {
    MAX_INPUT_BYTES as u32
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u32 {
    unsafe { OUT.as_ptr() }
}

#[no_mangle]
pub extern "C" fn view_ptr() -> *const i32 {
    unsafe { VIEW.as_ptr() }
}

/// Authoritative whole-log run. seed as two u32 halves; len <= 450.
/// Returns 0 ok / 1 TooLong / 2 NonZeroTrailer.
#[no_mangle]
pub extern "C" fn simulate_log(seed_lo: u32, seed_hi: u32, len: u32) -> u32 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    if len > MAX_INPUT_BYTES as u32 {
        return 1; // match ref-core/contract: reject, never truncate
    }
    let n = len as usize;
    let buf = unsafe { &*core::ptr::slice_from_raw_parts(IN_BUF.as_ptr(), n) };
    let out = unsafe { &mut *core::ptr::addr_of_mut!(OUT) };
    match simulate(seed, buf) {
        Ok(o) => {
            out[0] = o.score;
            out[1] = o.ticks;
            out[2] = o.fuel_left;
            out[3] = match o.status {
                Status::Landed => 1,
                Status::Crashed => 2,
                Status::Timeout => 3,
                Status::Running => 0,
            };
            0
        }
        Err(Reject::TooLong) => 1,
        Err(Reject::NonZeroTrailer) => 2,
    }
}

/// Reset the live stepper for a seed.
#[no_mangle]
pub extern "C" fn game_reset(seed_lo: u32, seed_hi: u32) -> u32 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    unsafe {
        SIM = Some(Sim::new(seed));
        let v = &mut *core::ptr::addr_of_mut!(VIEW);
        let s = SIM.as_mut().unwrap();
        v[0] = (s.x >> 16) as i32;
        v[1] = (s.y >> 16) as i32;
        v[2] = (s.vx >> 16) as i32;
        v[3] = (s.vy >> 16) as i32;
        v[4] = s.rot;
        v[5] = s.fuel as i32;
        v[6] = s.t as i32;
        v[7] = 0;
        v[8] = 0;
    }
    0
}

/// Advance the live game one tick. Returns status (0 running, 1 landed,
/// 2 crashed, 3 timeout, 255 uninitialised). VIEW refreshed each call.
#[no_mangle]
pub extern "C" fn game_step(action: u32) -> u32 {
    unsafe {
        let v = &mut *core::ptr::addr_of_mut!(VIEW);
        match SIM.as_mut() {
            None => 255,
            Some(s) => {
                let st = s.step(action as u8);
                v[0] = (s.x >> 16) as i32;
                v[1] = (s.y >> 16) as i32;
                v[2] = (s.vx >> 16) as i32;
                v[3] = (s.vy >> 16) as i32;
                v[4] = s.rot;
                v[5] = s.fuel as i32;
                v[6] = s.t as i32;
                v[7] = match st {
                    Status::Running => 0,
                    Status::Landed => 1,
                    Status::Crashed => 2,
                    Status::Timeout => 3,
                };
                v[8] = s.score() as i32;
                v[7] as u32
            }
        }
    }
}

/// Landing-pad segment index for the seed (0..SEGMENTS-1).
#[no_mangle]
pub extern "C" fn pad_segment(seed_lo: u32, seed_hi: u32) -> u32 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    let (_, pad, _) = terrain(seed);
    pad
}

/// Terrain control height (Q16.16 fixed-point) for control point i (0..=24).
/// Callers must shift right 16 to get integer px.
#[no_mangle]
pub extern "C" fn terrain_h_at(seed_lo: u32, seed_hi: u32, i: u32) -> i64 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    let (h, _, _) = terrain(seed);
    if i > SEGMENTS {
        return -1;
    }
    h[i as usize]
}

/// Ground height (integer px) at integer x — for canvas drawing.
#[no_mangle]
pub extern "C" fn ground_px(seed_lo: u32, seed_hi: u32, x_px: u32) -> i64 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    let (h, _, _) = terrain(seed);
    ground_at(&h, (x_px as i64) << 16) >> 16
}

/// Start x position (integer px); start y is 700.
#[no_mangle]
pub extern "C" fn start_x_px(seed_lo: u32, seed_hi: u32) -> i64 {
    let seed = (seed_lo as u64) | ((seed_hi as u64) << 32);
    let (x, _) = start_state(seed);
    x >> 16
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
