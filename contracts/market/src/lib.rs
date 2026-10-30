#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, panic_with_error, symbol_short, token, Address, BytesN, Env, String, Symbol};

const TTL: u32 = 1_036_800;
const MAX_POOL: i128 = 1_000_000_000_000_000_000;
const GRACE: u64 = 86_400;

#[contracttype]
#[derive(Clone)]
pub enum Key { Config, Count, Market(u32), Position(u32, Address) }
#[contracttype]
#[derive(Clone)]
pub struct Config { pub token: Address, pub resolver: Address }
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Kind { Event, Price(Symbol, i128) }
#[contracttype]
#[derive(Clone, Debug)]
pub struct Market {
    pub creator: Address, pub question: String, pub description_cid: String, pub image_cid: String,
    pub kind: Kind, pub closes_at: u64, pub deadline: u64,
    pub status: u32, pub yes_pool: i128, pub no_pool: i128,
    pub outcome: u32, pub confidence: u32, pub evidence: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug)]
pub struct Position { pub amount: i128, pub side: u32, pub claimed: bool }
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error { Missing = 1, Invalid = 2, Closed = 3, Duplicate = 4, NotReady = 5, Nothing = 6, Overflow = 7 }

fn config(e: &Env) -> Config {
    e.storage().instance().extend_ttl(TTL / 2, TTL);
    e.storage().instance().get(&Key::Config).unwrap()
}
fn market(e: &Env, id: u32) -> Market {
    let key = Key::Market(id);
    let m = e.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(e, Error::Missing));
    e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
    m
}
fn save(e: &Env, id: u32, m: &Market) {
    e.storage().persistent().set(&Key::Market(id), m);
    e.storage().persistent().extend_ttl(&Key::Market(id), TTL / 2, TTL);
}
fn settle_inner(e: &Env, id: u32, outcome: u32, confidence: u32, evidence: BytesN<32>) {
    let mut m = market(e, id);
    let now = e.ledger().timestamp();
    if m.status != 1 || now < m.closes_at || now > m.deadline { panic_with_error!(e, Error::NotReady); }
    if outcome > 1 || !(8000..=10000).contains(&confidence) || evidence == BytesN::from_array(e, &[0;32]) { panic_with_error!(e, Error::Invalid); }
    m.outcome = outcome;
    m.confidence = confidence;
    m.evidence = evidence;
    let winning = if outcome == 0 { m.yes_pool } else { m.no_pool };
    m.status = if winning == 0 { 3 } else { 2 };
    save(e, id, &m);
    e.events().publish((symbol_short!("settled"), id), (outcome, confidence));
}
fn settle(e: &Env, id: u32, outcome: u32, confidence: u32, evidence: BytesN<32>) {
    config(e).resolver.require_auth();
    settle_inner(e, id, outcome, confidence, evidence);
}

#[contract]
pub struct RevMarket;
#[contractimpl]
impl RevMarket {
    pub fn __constructor(e: Env, token: Address, resolver: Address) {
        if token::Client::new(&e, &token).decimals() != 7 { panic_with_error!(&e, Error::Invalid); }
        e.storage().instance().set(&Key::Config, &Config { token, resolver });
        e.storage().instance().set(&Key::Count, &0u32);
        e.storage().instance().extend_ttl(TTL / 2, TTL);
    }
    pub fn create(e: Env, creator: Address, question: String, description_cid: String, image_cid: String, kind: Kind, closes_at: u64) -> u32 {
        creator.require_auth();
        config(&e);
        let now = e.ledger().timestamp();
        if question.len() == 0 || question.len() > 512 || description_cid.len() > 128 || image_cid.len() > 128 || (matches!(&kind, Kind::Event) && image_cid.len() == 0) || closes_at <= now || closes_at > now + 2_592_000 { panic_with_error!(&e, Error::Invalid); }
        if let Kind::Price(ref asset, target) = kind {
            if target <= 0 || (*asset != symbol_short!("BTC") && *asset != symbol_short!("ETH") && *asset != symbol_short!("XLM")) { panic_with_error!(&e, Error::Invalid); }
        }
        let id: u32 = e.storage().instance().get(&Key::Count).unwrap();
        let next = id.checked_add(1).unwrap_or_else(|| panic_with_error!(&e, Error::Overflow));
        e.storage().instance().set(&Key::Count, &next);
        save(&e, id, &Market { creator, question, description_cid, image_cid, kind, closes_at, deadline: closes_at + GRACE, status: 0, yes_pool: 0, no_pool: 0, outcome: 0, confidence: 0, evidence: BytesN::from_array(&e, &[0;32]) });
        e.events().publish((symbol_short!("created"), id), closes_at);
        id
    }
    pub fn predict(e: Env, user: Address, id: u32, side: u32, amount: i128) {
        user.require_auth();
        let c = config(&e);
        let mut m = market(&e, id);
        if m.status != 0 || e.ledger().timestamp() >= m.closes_at { panic_with_error!(&e, Error::Closed); }
        if side > 1 || amount <= 0 || amount > MAX_POOL - m.yes_pool - m.no_pool { panic_with_error!(&e, Error::Invalid); }
        let key = Key::Position(id, user.clone());
        if e.storage().persistent().has(&key) { panic_with_error!(&e, Error::Duplicate); }
        token::Client::new(&e, &c.token).transfer(&user, &e.current_contract_address(), &amount);
        if side == 0 { m.yes_pool += amount; } else { m.no_pool += amount; }
        e.storage().persistent().set(&key, &Position { amount, side, claimed: false });
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        save(&e, id, &m);
        e.events().publish((symbol_short!("predict"), id), (user, side, amount));
    }
    pub fn request(e: Env, id: u32) {
        config(&e);
        let mut m = market(&e, id);
        if e.ledger().timestamp() < m.closes_at || e.ledger().timestamp() > m.deadline || m.status != 0 { panic_with_error!(&e, Error::NotReady); }
        m.status = 1;
        save(&e, id, &m);
        e.events().publish((symbol_short!("request"), id), m.closes_at);
    }
    pub fn settle_event(e: Env, id: u32, outcome: u32, confidence: u32, evidence: BytesN<32>) {
        config(&e).resolver.require_auth();
        if market(&e, id).kind != Kind::Event { panic_with_error!(&e, Error::Invalid); }
        settle_inner(&e, id, outcome, confidence, evidence);
    }
    pub fn settle_price(e: Env, id: u32, price: i128, evidence: BytesN<32>) {
        config(&e).resolver.require_auth();
        let m = market(&e, id);
        let threshold = match m.kind { Kind::Price(_, t) => t, _ => panic_with_error!(&e, Error::Invalid) };
        if price <= 0 { panic_with_error!(&e, Error::Invalid); }
        settle_inner(&e, id, if price > threshold { 0 } else { 1 }, 10000, evidence);
    }
    pub fn claim(e: Env, user: Address, id: u32) -> i128 {
        user.require_auth();
        let c = config(&e);
        let mut m = market(&e, id);
        if m.status < 2 && e.ledger().timestamp() > m.deadline { m.status = 3; save(&e, id, &m); }
        if m.status < 2 { panic_with_error!(&e, Error::NotReady); }
        let key = Key::Position(id, user.clone());
        let mut p: Position = e.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(&e, Error::Nothing));
        if p.claimed || (m.status == 2 && p.side != m.outcome) { panic_with_error!(&e, Error::Nothing); }
        let payout = if m.status == 3 { p.amount } else {
            let winning = if m.outcome == 0 { m.yes_pool } else { m.no_pool };
            p.amount * (m.yes_pool + m.no_pool) / winning
        };
        p.claimed = true;
        e.storage().persistent().set(&key, &p);
        e.storage().persistent().extend_ttl(&key, TTL / 2, TTL);
        token::Client::new(&e, &c.token).transfer(&e.current_contract_address(), &user, &payout);
        e.events().publish((symbol_short!("claimed"), id), (user, payout));
        payout
    }
    pub fn get_market(e: Env, id: u32) -> Market { config(&e); market(&e, id) }
    pub fn get_position(e: Env, id: u32, user: Address) -> Option<Position> {
        config(&e);
        let k = Key::Position(id, user);
        let p = e.storage().persistent().get(&k);
        if p.is_some() { e.storage().persistent().extend_ttl(&k, TTL / 2, TTL); }
        p
    }
    pub fn count(e: Env) -> u32 { config(&e); e.storage().instance().get(&Key::Count).unwrap() }
    // Submit as a transaction (simulation alone does not persist TTL extensions).
    pub fn keepalive(e: Env, id: u32, user: Address) {
        config(&e); market(&e, id);
        let key = Key::Position(id, user);
        if e.storage().persistent().has(&key) { e.storage().persistent().extend_ttl(&key, TTL / 2, TTL); }
    }
}

#[cfg(test)]
mod test;
