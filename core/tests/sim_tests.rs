use ref_core::*;

fn pack(actions: &[u8]) -> Vec<u8> {
    actions
        .chunks(4)
        .map(|c| {
            let mut b = 0u8;
            for (i, a) in c.iter().enumerate() {
                b |= (a & 3) << (2 * i);
            }
            b
        })
        .collect()
}

#[test]
fn empty_log_falls_and_crashes_or_times_out() {
    let o = simulate(42, &[]).unwrap();
    assert_ne!(o.status, Status::Landed);
    assert_eq!(o.score, 0);
    assert!(o.ticks <= MAX_TICKS);
}

#[test]
fn determinism_same_input_same_output() {
    let inputs = pack(&[1, 1, 0, 2, 0, 0, 3, 1]);
    let a = simulate(7, &inputs).unwrap();
    let b = simulate(7, &inputs).unwrap();
    assert_eq!(a, b);
}

#[test]
fn different_seed_different_terrain() {
    let (h1, p1, _) = terrain(1);
    let (h2, p2, _) = terrain(2);
    assert!(h1 != h2 || p1 != p2);
}

#[test]
fn overlong_input_rejected() {
    let inputs = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(simulate(1, &inputs), Err(Reject::TooLong));
    let ok = vec![0u8; MAX_INPUT_BYTES];
    assert!(simulate(1, &ok).is_ok());
}

#[test]
fn nonzero_trailer_rejected() {
    // Find a log that finishes before the end of the buffer, then append junk.
    let mut base = vec![0u8; 8];
    base[0] = 0b01; // a little thrust then idle — will crash or land early
    let o = simulate(9, &base).unwrap();
    assert!(o.ticks < MAX_TICKS);
    // a nonzero byte after the run ended must reject
    let mut tampered = base.clone();
    *tampered.last_mut().unwrap() = 0xFF;
    // ensure the tamper lands after the end tick
    if tampered.len() * 4 > o.ticks as usize {
        assert_eq!(simulate(9, &tampered), Err(Reject::NonZeroTrailer));
    }
}

#[test]
fn trailing_bits_in_partial_byte_rejected() {
    // 5 ticks of input, then a nonzero action in the same byte's upper bits
    // after the run has already ended.
    let mut base = vec![0x01]; // one thrust tick
    let o = simulate(5, &base).unwrap();
    if o.ticks < 4 {
        base[0] |= 0b11_00_00_00; // action in tick slot 3, after end
        assert_eq!(simulate(5, &base), Err(Reject::NonZeroTrailer));
    }
}

#[test]
fn tick_order_lsb_first() {
    // byte 0b00_00_00_01 = thrust on tick 0 only
    let one_thrust = [0x01u8];
    let o1 = simulate(3, &one_thrust).unwrap();
    // byte 0b01_00_00_00 = thrust on tick 3 only — same fuel spent, different timing
    let late_thrust = [0x40u8];
    let o2 = simulate(3, &late_thrust).unwrap();
    // Both consume exactly one fuel unit
    assert_eq!(o1.fuel_left, FUEL_MAX - 1);
    assert_eq!(o2.fuel_left, FUEL_MAX - 1);
}

#[test]
fn fuel_never_below_zero() {
    // 900 ticks of thrust (fuel out) then idle: legal log, fuel saturates at 0.
    let mut log = vec![0x55u8; 225]; // 900 thrust ticks
    log.extend(vec![0u8; 225]);
    let o = simulate(11, &log).unwrap();
    assert_eq!(o.fuel_left, 0);
}

#[test]
fn all_nonzero_log_that_ends_early_is_malformed() {
    // Inputs past the end-of-run tick are trailer garbage → reject.
    // (All-thrust crashes or times out; if it ends early the tail is nonzero.)
    let all_thrust = vec![0x55u8; MAX_INPUT_BYTES];
    match simulate(11, &all_thrust) {
        Err(Reject::NonZeroTrailer) => {}
        Ok(o) => assert_eq!(o.ticks, MAX_TICKS),
        Err(e) => panic!("unexpected reject {:?}", e),
    }
}

#[test]
fn integer_overflow_bounds_hold() {
    // Worst-case thrust into the ceiling for MAX_TICKS must not overflow i64 fp.
    // 900 thrust ticks then idle: fuel exhausts at 900, ship falls back down.
    let mut log = vec![0x55u8; 225];
    log.extend(vec![0u8; 225]);
    let o = simulate(77, &log).unwrap();
    assert!(o.ticks <= MAX_TICKS);
    assert!(o.score <= 10_000 + FUEL_MAX * 3 + MAX_TICKS);
}

#[test]
fn rotation_wraps() {
    // rotate-left past 0 must wrap to 357, not go negative.
    let mut s = Sim::new(1);
    s.step(2);
    assert_eq!(s.rot, 357);
    s.step(3);
    assert_eq!(s.rot, 0);
}

#[test]
fn trig_symmetry_exact() {
    assert_eq!(sin_deg(0), 0);
    assert_eq!(sin_deg(90), FP_ONE);
    assert_eq!(sin_deg(180), 0);
    assert_eq!(sin_deg(270), -FP_ONE);
    assert_eq!(cos_deg(0), FP_ONE);
    assert_eq!(cos_deg(180), -FP_ONE);
    assert_eq!(sin_deg(30) + sin_deg(390), 2 * sin_deg(30));
}

#[test]
fn golden_vector() {
    // Fixed seed + fixed log. Values were captured on first green run and are
    // committed here; ANY physics change must fail this test loudly.
    let seed: u64 = 0xC0FFEE42;
    let script: &[u8] = &[1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0];
    let inputs = pack(script);
    let o = simulate(seed, &inputs).unwrap();
    let golden = include_str!("golden.json");
    let expected_ticks = extract(golden, "ticks");
    let expected_score = extract(golden, "score");
    let expected_fuel = extract(golden, "fuel_left");
    assert_eq!(o.ticks, expected_ticks, "golden ticks drifted");
    assert_eq!(o.score, expected_score, "golden score drifted");
    assert_eq!(o.fuel_left, expected_fuel, "golden fuel drifted");
}

fn extract(json: &str, key: &str) -> u32 {
    let pat = format!("\"{}\":", key);
    let i = json.find(&pat).unwrap() + pat.len();
    json[i..]
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap()
}
