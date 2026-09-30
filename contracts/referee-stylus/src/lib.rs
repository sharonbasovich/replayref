//! Referee — Stylus contract that re-plays a lander run's input log under a
//! challenge seed before a score is accepted. The submitted score number is
//! never trusted: it is recomputed by the same ref-core crate the browser
//! runs as WASM.
//!
//! Honest scope: this proves a score is consistent with SOME valid input log
//! under the rules. It does not prove a human played it.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloy_primitives::{Address, Bytes, U64, U256};
use alloy_sol_types::sol;
use stylus_sdk::{crypto::keccak, prelude::*};

sol_storage! {
    #[entrypoint]
    pub struct Referee {
        uint256 num_challenges;
        mapping(uint256 => uint64) challenge_seed;
        mapping(uint256 => uint64) challenge_start;
        mapping(uint256 => uint64) challenge_end;
        mapping(uint256 => address) challenge_season;
        mapping(uint256 => bool) challenge_exists;
        mapping(uint256 => mapping(address => uint256)) best;
        mapping(uint256 => mapping(address => uint64)) best_block;
        mapping(uint256 => mapping(uint256 => address)) top_player;
        mapping(uint256 => mapping(uint256 => uint256)) top_score;
    }
}

sol! {
    event ChallengeCreated(uint256 indexed id, uint64 seed, uint64 start, uint64 end, address season);
    event RunAccepted(uint256 indexed id, address indexed player, uint32 score, bytes32 input_hash);

    error BadWindow();
    error ChallengeNotFound(uint256 id);
    error InvalidInputs();
    error ScoreMismatch(uint32 computed);
    error NotInWindow(uint64 start, uint64 end, uint64 now);
}

#[derive(SolidityError)]
pub enum RefereeError {
    BadWindow(BadWindow),
    ChallengeNotFound(ChallengeNotFound),
    InvalidInputs(InvalidInputs),
    ScoreMismatch(ScoreMismatch),
    NotInWindow(NotInWindow),
}

#[public]
impl Referee {
    /// Create an immutable challenge. start/end are unix seconds; submissions
    /// are only accepted inside [start, end].
    pub fn create_challenge(
        &mut self,
        seed: u64,
        start: u64,
        end: u64,
        season: Address,
    ) -> Result<U256, RefereeError> {
        if start >= end {
            return Err(BadWindow {}.into());
        }
        let id = self.num_challenges.get();
        self.num_challenges.set(id + U256::from(1));
        self.challenge_seed.setter(id).set(U64::from(seed));
        self.challenge_start.setter(id).set(U64::from(start));
        self.challenge_end.setter(id).set(U64::from(end));
        self.challenge_season.setter(id).set(season);
        self.challenge_exists.setter(id).set(true);
        self.vm().log(ChallengeCreated {
            id,
            seed,
            start,
            end,
            season,
        });
        Ok(id)
    }

    /// Free read-only replay: returns the score the contract computes for
    /// (challenge seed, inputs). Reverts if the log is malformed.
    pub fn verify(&self, id: U256, inputs: Bytes) -> Result<U256, RefereeError> {
        let seed = self.seed_or_revert(id)?;
        match ref_core::score_of(seed, &inputs) {
            Ok(score) => Ok(U256::from(score)),
            Err(_) => Err(InvalidInputs {}.into()),
        }
    }

    /// Recompute the run and record it if it beats the caller's best.
    /// Reverts ScoreMismatch(computed) when claimed != computed — the cheat
    /// is visible onchain.
    pub fn submit(
        &mut self,
        id: U256,
        inputs: Bytes,
        claimed: U256,
    ) -> Result<U256, RefereeError> {
        let seed = self.seed_or_revert(id)?;
        let start: u64 = self.challenge_start.get(id).to();
        let end: u64 = self.challenge_end.get(id).to();
        let now = self.vm().block_timestamp();
        if now < start || now > end {
            return Err(NotInWindow { start, end, now }.into());
        }
        let computed = match ref_core::score_of(seed, &inputs) {
            Ok(s) => s,
            Err(_) => return Err(InvalidInputs {}.into()),
        };
        if claimed != U256::from(computed) {
            return Err(ScoreMismatch { computed }.into());
        }

        let player = self.vm().msg_sender();
        let prev_best = self.best.getter(id).get(player);
        let new_score = U256::from(computed);
        if new_score > prev_best {
            self.best.setter(id).setter(player).set(new_score);
            let block = self.vm().block_number();
            self.best_block
                .setter(id)
                .setter(player)
                .set(U64::from(block));
            self.insert_top(id, player, computed);
            self.vm().log(RunAccepted {
                id,
                player,
                score: computed,
                input_hash: keccak(&inputs),
            });
        }
        Ok(new_score)
    }

    // ---- read-only getters ----

    pub fn num_challenges(&self) -> U256 {
        self.num_challenges.get()
    }

    pub fn challenge_seed(&self, id: U256) -> Result<U256, RefereeError> {
        self.exists_or_revert(id)?;
        Ok(U256::from(self.challenge_seed.get(id).to::<u64>()))
    }

    pub fn challenge_window(&self, id: U256) -> Result<(U256, U256), RefereeError> {
        self.exists_or_revert(id)?;
        Ok((
            U256::from(self.challenge_start.get(id).to::<u64>()),
            U256::from(self.challenge_end.get(id).to::<u64>()),
        ))
    }

    pub fn best(&self, id: U256, player: Address) -> U256 {
        self.best.getter(id).get(player)
    }

    pub fn top(&self, id: U256, i: U256) -> (Address, U256) {
        (
            self.top_player.getter(id).get(i),
            self.top_score.getter(id).get(i),
        )
    }
}

impl Referee {
    fn exists_or_revert(&self, id: U256) -> Result<(), RefereeError> {
        if !self.challenge_exists.get(id) {
            return Err(ChallengeNotFound { id }.into());
        }
        Ok(())
    }

    fn seed_or_revert(&self, id: U256) -> Result<u64, RefereeError> {
        self.exists_or_revert(id)?;
        Ok(self.challenge_seed.get(id).to())
    }

    /// Strictly-greater insert keeps ties with the earlier block.
    fn insert_top(&mut self, id: U256, player: Address, score: u32) {
        let score_u = U256::from(score);
        let mut slot: Option<usize> = None;
        for i in 0..3usize {
            let s = self.top_score.getter(id).get(U256::from(i));
            if score_u > s {
                slot = Some(i);
                break;
            }
        }
        let Some(slot) = slot else { return };
        // shift down
        for i in (slot + 1..3usize).rev() {
            let prev = U256::from(i - 1);
            let cur = U256::from(i);
            let p = self.top_player.getter(id).get(prev);
            let s = self.top_score.getter(id).get(prev);
            self.top_player.setter(id).setter(cur).set(p);
            self.top_score.setter(id).setter(cur).set(s);
        }
        let iu = U256::from(slot);
        self.top_player.setter(id).setter(iu).set(player);
        self.top_score.setter(id).setter(iu).set(score_u);
    }
}
