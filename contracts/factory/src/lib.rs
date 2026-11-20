#![no_std]
//! Registry of operator-approved market WASM hashes.
//!
//! Storage lifetime: the operator lives in instance storage and each
//! version-to-hash entry lives in persistent storage. Every write and every
//! successful read extends the touched entry to `TTL` ledgers (about 60 days
//! at 5s per ledger) whenever fewer than `TTL / 2` remain.
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address, BytesN, Env};

const TTL: u32 = 1_036_800;

#[contracttype]
enum Key { Operator, Version(u32) }

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error { Invalid = 1, Duplicate = 2 }

#[contract]
pub struct RevMarketFactory;

#[contractimpl]
impl RevMarketFactory {
    pub fn __constructor(e: Env, operator: Address) {
        e.storage().instance().set(&Key::Operator, &operator);
        e.storage().instance().extend_ttl(TTL / 2, TTL);
    }

    /// Operator-only. Registers `wasm_hash` under `version` once; entries are
    /// append-only. Emits topics `("approved", version)` with data `wasm_hash`.
    pub fn approve_version(e: Env, version: u32, wasm_hash: BytesN<32>) {
        let operator: Address = e.storage().instance().get(&Key::Operator).unwrap();
        operator.require_auth();
        e.storage().instance().extend_ttl(TTL / 2, TTL);
        if version == 0 || wasm_hash == BytesN::from_array(&e, &[0; 32]) { panic_with_error!(&e, Error::Invalid); }
        let key = Key::Version(version);
        if e.storage().persistent().has(&key) { panic_with_error!(&e, Error::Duplicate); }
        e.storage().persistent().set(&key, &wasm_hash);
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        e.events().publish((symbol_short!("approved"), version), wasm_hash);
    }

    /// Returns the approved hash for `version`, or None if it was never approved.
    pub fn get_version(e: Env, version: u32) -> Option<BytesN<32>> {
        let key = Key::Version(version);
        let hash: Option<BytesN<32>> = e.storage().persistent().get(&key);
        if hash.is_some() { e.storage().persistent().extend_ttl(&key, TTL / 2, TTL); }
        hash
    }
}

#[cfg(test)]
mod test;
