extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};

struct Fixture { e: Env, id: Address, token: Address, resolver: Address, a: Address, b: Address }
impl Fixture {
    fn new() -> Self {
        let e = Env::default();
        e.mock_all_auths();
        e.ledger().with_mut(|l| l.timestamp = 100);
        let admin = Address::generate(&e);
        let token = e.register_stellar_asset_contract_v2(admin).address();
        let resolver = Address::generate(&e);
        let id = e.register(RevMarket, (token.clone(), resolver.clone()));
        let a = Address::generate(&e);
        let b = Address::generate(&e);


















        
        let asset = token::StellarAssetClient::new(&e, &token);
        asset.mint(&a, &1000);
        asset.mint(&b, &1000);
        Self { e, id, token, resolver, a, b }
    }
    fn client(&self) -> RevMarketClient<'_> { RevMarketClient::new(&self.e, &self.id) }
    fn create(&self, kind: Kind) -> u32 {
        self.client().create(&self.a, &String::from_str(&self.e, "Test question"), &String::from_str(&self.e, ""), &String::from_str(&self.e, "https://example.com/market.jpg"), &kind, &200)
    }
    fn at(&self, t: u64) { self.e.ledger().with_mut(|l| l.timestamp = t); }
    fn hash(&self) -> BytesN<32> { BytesN::from_array(&self.e, &[1;32]) }
    fn balance(&self, a: &Address) -> i128 { token::Client::new(&self.e, &self.token).balance(a) }
}

#[test]
fn event_vertical_slice_with_real_token_transfers() {
    let f = Fixture::new(); let c = f.client(); let id = f.create(Kind::Event);
    c.predict(&f.a, &id, &0, &100); c.predict(&f.b, &id, &1, &300);
    assert_eq!(f.balance(&f.id), 400);
    f.at(200); c.request(&id); c.settle_event(&id, &0, &9000, &f.hash());
    assert_eq!(c.claim(&f.a, &id), 400);
    assert_eq!(f.balance(&f.a), 1300); assert_eq!(f.balance(&f.b), 700); assert_eq!(f.balance(&f.id), 0);
    assert!(c.try_claim(&f.a, &id).is_err()); assert!(c.try_claim(&f.b, &id).is_err());
}
#[test]
fn price_equality_is_no_and_other_path_rejected() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Price(symbol_short!("ETH"), 100));
    c.predict(&f.a,&id,&0,&100); c.predict(&f.b,&id,&1,&100);
    f.at(200); c.request(&id);
    assert!(c.try_settle_event(&id,&0,&10000,&f.hash()).is_err());
    c.settle_price(&id,&100,&f.hash()); assert_eq!(c.get_market(&id).outcome,1);
    assert_eq!(c.claim(&f.b,&id),200);
}
#[test]
fn price_above_target_is_yes() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Price(symbol_short!("BTC"),100));
    c.predict(&f.a,&id,&0,&100); f.at(200); c.request(&id); c.settle_price(&id,&101,&f.hash());
    assert_eq!(c.get_market(&id).outcome,0); assert_eq!(c.claim(&f.a,&id),100);
}
#[test]
fn invalid_and_duplicate_predictions_and_close_boundary() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    assert!(c.try_predict(&f.a,&id,&2,&100).is_err()); assert!(c.try_predict(&f.a,&id,&0,&0).is_err());
    assert!(c.try_predict(&f.a,&id,&0,&-1).is_err());
    assert!(c.try_predict(&f.a,&id,&0,&(MAX_POOL+1)).is_err());
    c.predict(&f.a,&id,&0,&100); assert!(c.try_predict(&f.a,&id,&1,&100).is_err());
    assert!(c.try_request(&id).is_err()); f.at(200); assert!(c.try_predict(&f.b,&id,&1,&100).is_err());
    assert_eq!(f.balance(&f.id),100);
}
#[test]
fn no_winners_refunds_everyone() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    c.predict(&f.a,&id,&0,&100); f.at(200); c.request(&id); c.settle_event(&id,&1,&9000,&f.hash());
    assert_eq!(c.get_market(&id).status,3); assert_eq!(c.claim(&f.a,&id),100); assert_eq!(f.balance(&f.a),1000);
}
#[test]
fn unresolved_timeout_refunds_and_late_settlement_fails() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    c.predict(&f.a,&id,&0,&100); c.predict(&f.b,&id,&1,&300); f.at(200); c.request(&id);
    f.at(200+GRACE); assert!(c.try_claim(&f.a,&id).is_err());
    f.at(201+GRACE); assert!(c.try_settle_event(&id,&0,&9000,&f.hash()).is_err());
    assert_eq!(c.claim(&f.a,&id),100); assert_eq!(c.claim(&f.b,&id),300); assert_eq!(f.balance(&f.id),0);
}
#[test]
fn no_request_also_refundable() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    c.predict(&f.a,&id,&0,&100); f.at(201+GRACE); assert_eq!(c.claim(&f.a,&id),100);
}
#[test]
fn evidence_confidence_type_and_replay_guards() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); f.at(200);
    assert!(c.try_settle_event(&id,&0,&9000,&f.hash()).is_err()); c.request(&id);
    assert!(c.try_request(&id).is_err());
    assert!(c.try_settle_event(&id,&0,&7999,&f.hash()).is_err());
    assert!(c.try_settle_event(&id,&0,&10001,&f.hash()).is_err());
    assert!(c.try_settle_event(&id,&0,&9000,&BytesN::from_array(&f.e,&[0;32])).is_err());
    assert!(c.try_settle_price(&id,&100,&f.hash()).is_err());
    c.settle_event(&id,&0,&9000,&f.hash()); assert!(c.try_settle_event(&id,&0,&9000,&f.hash()).is_err());
}
#[test]
fn auth_enforced_without_mocks() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    f.at(200); c.request(&id); f.e.mock_auths(&[]);
    assert!(c.try_settle_event(&id,&0,&9000,&f.hash()).is_err());
    assert!(c.try_create(&f.a,&String::from_str(&f.e,"x"),&String::from_str(&f.e,""),&String::from_str(&f.e,"https://example.com/market.jpg"),&Kind::Event,&300).is_err());
    assert!(c.try_predict(&f.a,&id,&0,&10).is_err());
    assert!(c.try_claim(&f.a,&id).is_err());
    let _ = &f.resolver;
}
#[test]
fn payout_conservation_rounding_and_market_isolation() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let other=f.create(Kind::Event);
    let third=Address::generate(&f.e); token::StellarAssetClient::new(&f.e,&f.token).mint(&third,&100);
    c.predict(&f.a,&id,&0,&2); c.predict(&f.b,&id,&0,&1); c.predict(&third,&id,&1,&1);
    c.predict(&third,&other,&0,&10); f.at(200); c.request(&id); c.settle_event(&id,&0,&9000,&f.hash());
    assert_eq!(c.claim(&f.a,&id),2); assert_eq!(c.claim(&f.b,&id),1);
    assert_eq!(f.balance(&f.id),11); // 1 unit dust + untouched second market escrow.
    f.at(201+GRACE); assert_eq!(c.claim(&third,&other),10); assert_eq!(f.balance(&f.id),1);
}
#[test]
fn invalid_creation_and_missing_market() {
    let f=Fixture::new(); let c=f.client();
    assert!(c.try_get_market(&99).is_err());
    assert!(c.try_create(&f.a,&String::from_str(&f.e,""),&String::from_str(&f.e,""),&String::from_str(&f.e,"https://example.com/market.jpg"),&Kind::Event,&200).is_err());
    assert!(c.try_create(&f.a,&String::from_str(&f.e,"x"),&String::from_str(&f.e,""),&String::from_str(&f.e,"https://example.com/market.jpg"),&Kind::Event,&100).is_err());
    assert!(c.try_create(&f.a,&String::from_str(&f.e,"x"),&String::from_str(&f.e,""),&String::from_str(&f.e,""),&Kind::Price(symbol_short!("BAD"),100),&200).is_err());
    assert!(c.try_create(&f.a,&String::from_str(&f.e,"x"),&String::from_str(&f.e,""),&String::from_str(&f.e,""),&Kind::Event,&200).is_err());
}
