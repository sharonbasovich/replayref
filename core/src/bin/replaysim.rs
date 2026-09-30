//! replaysim — native CLI over ref-core for corpus evaluation.
//!
//!   replaysim once <seed_u64> <inputs_hex>
//!       -> one JSON line {"status","ticks","fuel_left","score"} or {"reject"}
//!   replaysim corpus <jsonl_file>
//!       each input line: {"id","seed","inputs" (hex), "claim" (optional)}
//!       -> one JSON line per input with the computed outcome
//!   replaysim golden
//!       -> prints the golden-vector JSON for tests/golden.json

use std::io::{BufRead, BufReader, Write};

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn outcome_json(o: &ref_core::Outcome) -> String {
    let status = match o.status {
        ref_core::Status::Landed => "landed",
        ref_core::Status::Crashed => "crashed",
        ref_core::Status::Timeout => "timeout",
        ref_core::Status::Running => "running",
    };
    format!(
        "{{\"status\":\"{}\",\"ticks\":{},\"fuel_left\":{},\"score\":{}}}",
        status, o.ticks, o.fuel_left, o.score
    )
}

fn reject_json(r: &ref_core::Reject) -> String {
    let k = match r {
        ref_core::Reject::TooLong => "too_long",
        ref_core::Reject::NonZeroTrailer => "nonzero_trailer",
    };
    format!("{{\"reject\":\"{}\"}}", k)
}

// Minimal JSON field extractors — the corpus format is machine-generated and
// stable, so a parser crate is overkill; keep this dependency-free.
fn json_str<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{}\":", key);
    let i = line.find(&pat)? + pat.len();
    let rest = line[i..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let start = i + (line.len() - i - rest.len()) + 1;
    let j = line[start..].find('"')? + start;
    Some(&line[start..j])
}

fn json_u64(line: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{}\":", key);
    let i = line.find(&pat)? + pat.len();
    let rest = line[i..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("once") => {
            let seed: u64 = args[2].parse().expect("seed u64");
            let inputs = unhex(&args[3]).expect("hex inputs");
            match ref_core::simulate(seed, &inputs) {
                Ok(o) => println!("{}", outcome_json(&o)),
                Err(r) => println!("{}", reject_json(&r)),
            }
        }
        Some("corpus") => {
            let f = std::fs::File::open(&args[2]).expect("open corpus");
            let stdout = std::io::stdout();
            let mut out = std::io::BufWriter::new(stdout.lock());
            for line in BufReader::new(f).lines() {
                let line = line.unwrap();
                if line.trim().is_empty() {
                    continue;
                }
                let id = json_str(&line, "id").unwrap_or("?").to_string();
                let seed = json_u64(&line, "seed")
                    .or_else(|| json_str(&line, "seed").and_then(|s| s.parse().ok()))
                    .expect("seed");
                let inputs = unhex(json_str(&line, "inputs").unwrap_or("")).expect("inputs");
                let res = match ref_core::simulate(seed, &inputs) {
                    Ok(o) => outcome_json(&o),
                    Err(r) => reject_json(&r),
                };
                writeln!(out, "{{\"id\":\"{}\",\"result\":{}}}", id, res).unwrap();
            }
        }
        Some("golden") => {
            // Fixed seed + fixed scripted log → fixed score. If this ever
            // changes, a physics edit slipped in — that is the point of it.
            let seed: u64 = 0xC0FF_EE42;
            let mut inputs = vec![0u8; 0];
            // hover-ish log: bursts of thrust with pauses, then idle
            let script: &[u8] = &[1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0];
            for chunk in script.chunks(4) {
                let mut b = 0u8;
                for (i, a) in chunk.iter().enumerate() {
                    b |= a << (2 * i);
                }
                inputs.push(b);
            }
            match ref_core::simulate(seed, &inputs) {
                Ok(o) => println!(
                    "{{\"seed\":\"0x{:x}\",\"inputs\":\"{}\",\"expected\":{}}}",
                    seed,
                    script
                        .chunks(4)
                        .map(|c| {
                            let mut b = 0u8;
                            for (i, a) in c.iter().enumerate() {
                                b |= a << (2 * i);
                            }
                            format!("{:02x}", b)
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                    outcome_json(&o)
                ),
                Err(r) => println!("{}", reject_json(&r)),
            }
        }
        _ => {
            eprintln!("usage: replaysim once <seed> <hex> | corpus <file> | golden");
            std::process::exit(2);
        }
    }
}
