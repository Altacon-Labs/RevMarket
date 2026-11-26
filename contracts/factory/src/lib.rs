#![no_std]
//! RevMarket factory contract: approved WASM version registry, authoritative
//! reviewer role management, and dual-authorized reviewed market deployment.
//!
//! Storage lifetime: operator, pause flag, and market count live in instance
//! storage; versions, reviewer roles, creator nonces, and market records live
//! in persistent storage. Every write and successful read extends the touched
//! entry to `TTL` ledgers (~60 days at 5s/ledger) when fewer than `TTL / 2` remain.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    xdr::ToXdr, Address, Bytes, BytesN, Env, String, Vec,
};

const TTL: u32 = 1_036_800;
const MAX_FEE_BPS: u32 = 1_000;
const MAX_LIST_LIMIT: u32 = 50;

#[contracttype]
#[derive(Clone)]
enum Key {
    Operator,
    Paused,
    Version(u32),
    Reviewer(Address),
    Nonce(Address, BytesN<32>),
    Market(Address),
    MarketCount,
    MarketAt(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewerRole {
    pub enabled: bool,
    pub epoch: u32,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum NonceState {
    Unused = 0,
    Consumed = 1,
    Invalidated = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketParams {
    pub network_id: BytesN<32>,
    pub rules_digest: BytesN<32>,
    pub metadata_cid: String,
    pub collateral: Address,
    pub closes_at: u64,
    pub resolution_deadline: u64,
    pub resolver: Address,
    pub resolution_policy_hash: BytesN<32>,
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketRecord {
    pub address: Address,
    pub creator: Address,
    pub reviewer: Address,
    pub reviewer_epoch: u32,
    pub version: u32,
    pub wasm_hash: BytesN<32>,
    pub rules_digest: BytesN<32>,
    pub params_hash: BytesN<32>,
    pub nonce: BytesN<32>,
    pub created_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    Invalid = 1,
    Duplicate = 2,
    Paused = 3,
    UnknownVersion = 4,
    UnauthorizedReviewer = 5,
    SelfReview = 6,
    Expired = 7,
    NonceUsed = 8,
    NonceInvalidated = 9,
    WrongNetwork = 10,
    WasmMismatch = 11,
}

fn require_operator(e: &Env) -> Address {
    let operator: Address = e.storage().instance().get(&Key::Operator).unwrap();
    operator.require_auth();
    e.storage().instance().extend_ttl(TTL / 2, TTL);
    operator
}

fn is_paused(e: &Env) -> bool {
    e.storage().instance().get(&Key::Paused).unwrap_or(false)
}

#[contract]
pub struct RevMarketFactory;

#[contractimpl]
impl RevMarketFactory {
    pub fn __constructor(e: Env, operator: Address) {
        e.storage().instance().set(&Key::Operator, &operator);
        e.storage().instance().set(&Key::Paused, &false);
        e.storage().instance().set(&Key::MarketCount, &0u32);
        e.storage().instance().extend_ttl(TTL / 2, TTL);
    }

    /// Operator-only. Registers `wasm_hash` under `version` once; entries are
    /// append-only. Emits topics `("approved", version)` with data `wasm_hash`.
    pub fn approve_version(e: Env, version: u32, wasm_hash: BytesN<32>) {
        require_operator(&e);
        if version == 0 || wasm_hash == BytesN::from_array(&e, &[0; 32]) {
            panic_with_error!(&e, Error::Invalid);
        }
        let key = Key::Version(version);
        if e.storage().persistent().has(&key) {
            panic_with_error!(&e, Error::Duplicate);
        }
        e.storage().persistent().set(&key, &wasm_hash);
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        e.events().publish((symbol_short!("approved"), version), wasm_hash);
    }

    /// Returns the approved hash for `version`, or None if it was never approved.
    pub fn get_version(e: Env, version: u32) -> Option<BytesN<32>> {
        let key = Key::Version(version);
        let hash: Option<BytesN<32>> = e.storage().persistent().get(&key);
        if hash.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        }
        hash
    }

    /// Operator-only. Pauses or unpauses reviewed market creation without affecting deployed markets.
    pub fn set_creation_paused(e: Env, paused: bool) {
        require_operator(&e);
        e.storage().instance().set(&Key::Paused, &paused);
        e.events().publish((symbol_short!("paused"),), paused);
    }

    /// Returns whether new market creation is currently paused.
    pub fn is_creation_paused(e: Env) -> bool {
        e.storage().instance().extend_ttl(TTL / 2, TTL);
        is_paused(&e)
    }

    /// Operator-only. Enables or revokes a reviewer and monotonically advances their role epoch
    /// so previously signed, unexecuted approvals cannot be replayed after revocation or re-enable.
    pub fn set_reviewer(e: Env, reviewer: Address, enabled: bool) -> ReviewerRole {
        require_operator(&e);
        let key = Key::Reviewer(reviewer.clone());
        let current: ReviewerRole = e
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(ReviewerRole { enabled: false, epoch: 0 });
        let next_epoch = current
            .epoch
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&e, Error::Invalid));
        let updated = ReviewerRole {
            enabled,
            epoch: next_epoch,
        };
        e.storage().persistent().set(&key, &updated);
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        e.events()
            .publish((symbol_short!("rev_role"), reviewer), (enabled, next_epoch));
        updated
    }

    /// Returns the authoritative on-chain reviewer role (defaults to disabled, epoch 0).
    pub fn get_reviewer(e: Env, reviewer: Address) -> ReviewerRole {
        let key = Key::Reviewer(reviewer);
        let role: Option<ReviewerRole> = e.storage().persistent().get(&key);
        if role.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        }
        role.unwrap_or(ReviewerRole { enabled: false, epoch: 0 })
    }

    /// Creator-only. Permanently invalidates an unused creation nonce so a withdrawn intent
    /// cannot be executed on-chain. Fails with `NonceUsed` if deployment already completed.
    pub fn invalidate_creation_nonce(e: Env, creator: Address, nonce: BytesN<32>) {
        creator.require_auth();
        if nonce == BytesN::from_array(&e, &[0; 32]) {
            panic_with_error!(&e, Error::Invalid);
        }
        let key = Key::Nonce(creator.clone(), nonce.clone());
        let current: NonceState = e
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(NonceState::Unused);
        if current == NonceState::Consumed {
            panic_with_error!(&e, Error::NonceUsed);
        }
        e.storage().persistent().set(&key, &NonceState::Invalidated);
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        e.events()
            .publish((symbol_short!("nonce_inv"), creator), nonce);
    }

    /// Returns the current state of a creator's deployment nonce.
    pub fn get_nonce_state(e: Env, creator: Address, nonce: BytesN<32>) -> NonceState {
        let key = Key::Nonce(creator, nonce);
        let state: Option<NonceState> = e.storage().persistent().get(&key);
        if state.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        }
        state.unwrap_or(NonceState::Unused)
    }

    /// Dual-authorized reviewed deployment entrypoint.
    /// Requires both `creator` and `reviewer` to authorize the exact parameters,
    /// verifies active reviewer role & epoch, pinned version/WASM hash, network ID,
    /// expiry, and unused nonce, then atomically deploys and registers the market.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        e: Env,
        creator: Address,
        reviewer: Address,
        version: u32,
        wasm_hash: BytesN<32>,
        nonce: BytesN<32>,
        approval_expires_at: u64,
        reviewer_epoch: u32,
        params: MarketParams,
    ) -> MarketRecord {
        creator.require_auth();
        reviewer.require_auth();
        e.storage().instance().extend_ttl(TTL / 2, TTL);

        if is_paused(&e) {
            panic_with_error!(&e, Error::Paused);
        }
        if creator == reviewer {
            panic_with_error!(&e, Error::SelfReview);
        }
        if params.network_id != e.ledger().network_id() {
            panic_with_error!(&e, Error::WrongNetwork);
        }
        let now = e.ledger().timestamp();
        if now >= approval_expires_at {
            panic_with_error!(&e, Error::Expired);
        }

        let zero = BytesN::from_array(&e, &[0; 32]);
        if version == 0
            || nonce == zero
            || params.rules_digest == zero
            || params.resolution_policy_hash == zero
            || params.metadata_cid.is_empty()
            || params.closes_at <= now
            || params.resolution_deadline <= params.closes_at
            || params.fee_bps > MAX_FEE_BPS
        {
            panic_with_error!(&e, Error::Invalid);
        }

        let approved_wasm = Self::get_version(e.clone(), version)
            .unwrap_or_else(|| panic_with_error!(&e, Error::UnknownVersion));
        if approved_wasm != wasm_hash {
            panic_with_error!(&e, Error::WasmMismatch);
        }

        let role = Self::get_reviewer(e.clone(), reviewer.clone());
        if !role.enabled || role.epoch != reviewer_epoch {
            panic_with_error!(&e, Error::UnauthorizedReviewer);
        }

        let nonce_key = Key::Nonce(creator.clone(), nonce.clone());
        let nonce_state: NonceState = e
            .storage()
            .persistent()
            .get(&nonce_key)
            .unwrap_or(NonceState::Unused);
        match nonce_state {
            NonceState::Unused => {}
            NonceState::Consumed => panic_with_error!(&e, Error::NonceUsed),
            NonceState::Invalidated => panic_with_error!(&e, Error::NonceInvalidated),
        }

        let params_hash: BytesN<32> = e.crypto().sha256(&params.clone().to_xdr(&e)).into();
        let mut salt_preimage = Bytes::new(&e);
        salt_preimage.append(&e.ledger().network_id().to_xdr(&e));
        salt_preimage.append(&e.current_contract_address().to_xdr(&e));
        salt_preimage.append(&creator.to_xdr(&e));
        salt_preimage.append(&reviewer.to_xdr(&e));
        salt_preimage.append(&reviewer_epoch.to_xdr(&e));
        salt_preimage.append(&version.to_xdr(&e));
        salt_preimage.append(&wasm_hash.to_xdr(&e));
        salt_preimage.append(&nonce.to_xdr(&e));
        salt_preimage.append(&params_hash.to_xdr(&e));
        let salt: BytesN<32> = e.crypto().sha256(&salt_preimage).into();

        #[cfg(not(test))]
        let market_address = e.deployer().with_current_contract(salt).deploy_v2(
            wasm_hash.clone(),
            (
                e.current_contract_address(),
                creator.clone(),
                reviewer.clone(),
                version,
                params.rules_digest.clone(),
                params_hash.clone(),
                params.clone(),
            ),
        );
        #[cfg(test)]
        let market_address = e.deployer().with_current_contract(salt).deployed_address();

        e.storage().persistent().set(&nonce_key, &NonceState::Consumed);
        e.storage().persistent().extend_ttl(&nonce_key, TTL / 2, TTL);

        let record = MarketRecord {
            address: market_address.clone(),
            creator: creator.clone(),
            reviewer: reviewer.clone(),
            reviewer_epoch,
            version,
            wasm_hash: wasm_hash.clone(),
            rules_digest: params.rules_digest.clone(),
            params_hash: params_hash.clone(),
            nonce,
            created_at: now,
        };

        let mkt_key = Key::Market(market_address.clone());
        e.storage().persistent().set(&mkt_key, &record);
        e.storage().persistent().extend_ttl(&mkt_key, TTL / 2, TTL);

        let count: u32 = e.storage().instance().get(&Key::MarketCount).unwrap_or(0);
        let idx_key = Key::MarketAt(count);
        e.storage().persistent().set(&idx_key, &market_address);
        e.storage().persistent().extend_ttl(&idx_key, TTL / 2, TTL);
        e.storage()
            .instance()
            .set(&Key::MarketCount, &(count + 1));

        e.events().publish(
            (symbol_short!("mkt_new"), market_address),
            (
                creator,
                reviewer,
                version,
                wasm_hash,
                params.rules_digest,
                params_hash,
            ),
        );

        record
    }

    /// Returns the registered `MarketRecord` for `address`, or None if not deployed by this factory.
    pub fn get_market(e: Env, address: Address) -> Option<MarketRecord> {
        let key = Key::Market(address);
        let record: Option<MarketRecord> = e.storage().persistent().get(&key);
        if record.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        }
        record
    }

    /// Returns a bounded page of registered `MarketRecord` entries starting at `start`.
    pub fn list_markets(e: Env, start: u32, limit: u32) -> Vec<MarketRecord> {
        e.storage().instance().extend_ttl(TTL / 2, TTL);
        let count: u32 = e.storage().instance().get(&Key::MarketCount).unwrap_or(0);
        let bounded_limit = limit.min(MAX_LIST_LIMIT);
        let end = start.saturating_add(bounded_limit).min(count);
        let mut out = Vec::new(&e);
        let mut i = start;
        while i < end {
            let idx_key = Key::MarketAt(i);
            if let Some(addr) = e.storage().persistent().get::<Key, Address>(&idx_key) {
                e.storage().persistent().extend_ttl(&idx_key, TTL / 2, TTL);
                if let Some(rec) = Self::get_market(e.clone(), addr) {
                    out.push_back(rec);
                }
            }
            i += 1;
        }
        out
    }
}

#[cfg(test)]
mod test;
