//! autopilot — deterministic closed-loop pilot for corpus/demo generation.
//! Emits input logs that actually land (when the seed allows it), so the
//! corpus exercises the landed path, not only crashes.
//!
//!   autopilot <seed_u64>
//!       -> {"seed","inputs","status","ticks","fuel_left","score"}

use ref_core::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut sim = Sim::new(seed);
    let (plo, phi) = sim.pad_range();
    let pad_c = (plo + phi) / 2;

    // recorded actions, packed 4-per-byte
    let mut actions: Vec<u8> = Vec::new();

    while sim.status == Status::Running {
        let x = sim.x;
        let y = sim.y;
        let vx = sim.vx;
        let vy = sim.vy;
        let rot = sim.rot;
        let alt = y - sim.ground(x);

        // desired horizontal velocity toward pad center (px/tick in fp)
        let dx = pad_c - x;
        let mut des_vx = dx / 250; // gentle approach
        if des_vx > FP_ONE * 7 / 10 {
            des_vx = FP_ONE * 7 / 10;
        }
        if des_vx < -FP_ONE * 7 / 10 {
            des_vx = -FP_ONE * 7 / 10;
        }
        let vx_err = des_vx - vx;

        // desired vertical velocity: fall fast when high, brake near ground
        let des_vy = if alt > (350 << 16) {
            -FP_ONE // -1.0 px/tick
        } else if alt > (150 << 16) {
            -FP_ONE * 7 / 10
        } else {
            -FP_ONE * 4 / 10 // final approach sink rate
        };
        let vy_err = vy - des_vy; // >0 means falling too slow / rising

        // rotation target from horizontal error
        let rot_signed = if rot > 180 { rot - 360 } else { rot };
        let rot_tgt = if vx_err > FP_ONE / 8 {
            25
        } else if vx_err < -FP_ONE / 8 {
            -25
        } else {
            0
        };
        let rot_err = rot_tgt - rot_signed;

        let action = if rot_err.abs() > 6 {
            if rot_err > 0 {
                3u8
            } else {
                2u8
            }
        } else if vy_err < 0 && rot_signed.abs() < 40 {
            1u8 // thrust
        } else if rot_err.abs() > 1 {
            if rot_err > 0 {
                3u8
            } else {
                2u8
            }
        } else {
            0u8
        };
        actions.push(action);
        sim.step(action);
    }

    // pack
    let mut bytes = Vec::with_capacity(actions.len() / 4 + 1);
    for c in actions.chunks(4) {
        let mut b = 0u8;
        for (i, a) in c.iter().enumerate() {
            b |= (a & 3) << (2 * i);
        }
        bytes.push(b);
    }
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    let status = match sim.status {
        Status::Landed => "landed",
        Status::Crashed => "crashed",
        Status::Timeout => "timeout",
        Status::Running => "running",
    };
    println!(
        "{{\"seed\":{},\"inputs\":\"{}\",\"status\":\"{}\",\"ticks\":{},\"fuel_left\":{},\"score\":{}}}",
        seed,
        hex,
        status,
        sim.t,
        sim.fuel,
        sim.score()
    );
}
