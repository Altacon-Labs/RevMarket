extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, IntoVal};

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
    // Authorize exactly one invocation of `fn_name` by `who`; every other require_auth fails.
    fn sign<A: IntoVal<Env, soroban_sdk::Vec<soroban_sdk::Val>>>(&self, who: &Address, fn_name: &str, args: A) {
        self.e.mock_auths(&[MockAuth { address: who, invoke: &MockAuthInvoke { contract: &self.id, fn_name, args: args.into_val(&self.e), sub_invokes: &[] } }]);
    }
    fn settled(&self) -> u32 {
        let c = self.client(); let id = self.create(Kind::Event);
        c.predict(&self.a, &id, &0, &100); c.predict(&self.b, &id, &1, &300); self.at(200); c.request(&id); c.settle_event(&id, &0, &9000, &self.hash());
        id
    }
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
#[test]
fn delegated_claim_pays_owner_with_keeper_auth_only() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let keeper=Address::generate(&f.e);
    c.grant_claimer(&f.a,&keeper,&(100+MAX_PERMIT));
    assert_eq!(c.get_claimer(&f.a),Some(ClaimPermit{keeper:keeper.clone(),expires_at:100+MAX_PERMIT}));
    c.predict(&f.a,&id,&0,&100); c.predict(&f.b,&id,&1,&300); f.at(200); c.request(&id); c.settle_event(&id,&0,&9000,&f.hash());
    assert_eq!(c.claim_for(&keeper,&f.a,&id),400);
    assert_eq!(f.e.auths(),std::vec![(keeper.clone(),AuthorizedInvocation{function:AuthorizedFunction::Contract((f.id.clone(),Symbol::new(&f.e,"claim_for"),(keeper.clone(),f.a.clone(),id).into_val(&f.e))),sub_invocations:std::vec![]})]);
    assert_eq!(f.balance(&f.a),1300); assert_eq!(f.balance(&keeper),0); assert_eq!(f.balance(&f.id),0);
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Nothing.into()))); assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.try_claim_for(&keeper,&f.b,&id),Err(Ok(Error::Denied.into())));
}
#[test]
fn delegated_claim_fails_closed_for_missing_wrong_revoked_and_expired_permits() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let keeper=Address::generate(&f.e); let other=Address::generate(&f.e);
    c.predict(&f.a,&id,&0,&100); f.at(201+GRACE);
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Denied.into())));
    let exp=201+GRACE+10; c.grant_claimer(&f.a,&keeper,&exp);
    assert_eq!(c.try_claim_for(&other,&f.a,&id),Err(Ok(Error::Denied.into())));
    assert_eq!(c.try_claim_for(&f.a,&f.a,&id),Err(Ok(Error::Denied.into())));
    c.revoke_claimer(&f.a); assert_eq!(c.get_claimer(&f.a),None);
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Denied.into())));
    c.grant_claimer(&f.a,&keeper,&exp); f.at(exp);
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Denied.into())));
    f.at(exp-1); assert_eq!(c.claim_for(&keeper,&f.a,&id),100); // timeout refund still goes to owner
    assert_eq!(f.balance(&f.a),1000); assert_eq!(f.balance(&keeper),0);
}
#[test]
fn grant_bounds_events_and_loser_rejection() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let keeper=Address::generate(&f.e);
    assert_eq!(c.try_grant_claimer(&f.a,&keeper,&100),Err(Ok(Error::Invalid.into())));
    assert_eq!(c.try_grant_claimer(&f.a,&keeper,&(101+MAX_PERMIT)),Err(Ok(Error::Invalid.into())));
    assert_eq!(c.try_grant_claimer(&f.a,&f.a,&200),Err(Ok(Error::Invalid.into())));
    c.grant_claimer(&f.a,&keeper,&300);
    assert_eq!(f.e.events().all(),vec![&f.e,(f.id.clone(),vec![&f.e,symbol_short!("grant").into_val(&f.e),f.a.into_val(&f.e)],(keeper.clone(),300u64).into_val(&f.e))]);
    c.revoke_claimer(&f.a);
    assert_eq!(f.e.events().all(),vec![&f.e,(f.id.clone(),vec![&f.e,symbol_short!("revoke").into_val(&f.e),f.a.into_val(&f.e)],().into_val(&f.e))]);
    c.grant_claimer(&f.a,&keeper,&300);
    c.predict(&f.a,&id,&1,&100); c.predict(&f.b,&id,&0,&100); f.at(200); c.request(&id); c.settle_event(&id,&0,&9000,&f.hash());
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Nothing.into()))); assert_eq!(f.balance(&f.id),200);
}
#[test]
fn permit_auth_enforced_without_mocks() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let keeper=Address::generate(&f.e);
    c.predict(&f.a,&id,&0,&100); c.grant_claimer(&f.a,&keeper,&300); f.at(201+GRACE); f.e.mock_auths(&[]);
    assert!(c.try_grant_claimer(&f.a,&keeper,&400).is_err());
    assert!(c.try_revoke_claimer(&f.a).is_err());
    assert!(c.try_claim_for(&keeper,&f.a,&id).is_err());
    assert_eq!(c.get_claimer(&f.a).unwrap().keeper,keeper); assert_eq!(f.balance(&f.id),100);
}
#[test]
fn settlement_requires_the_resolver_not_another_signer() {
    let f=Fixture::new(); let c=f.client(); let ev=f.create(Kind::Event); let px=f.create(Kind::Price(symbol_short!("XLM"),100));
    c.predict(&f.a,&ev,&0,&100); c.predict(&f.a,&px,&0,&100); f.at(200); c.request(&ev); c.request(&px);
    let ev_args=(ev,0u32,9000u32,f.hash()); let px_args=(px,101i128,f.hash());
    for who in [&f.a,&f.b] {
        f.sign(who,"settle_event",ev_args.clone()); assert!(c.try_settle_event(&ev,&0,&9000,&f.hash()).is_err());
        f.sign(who,"settle_price",px_args.clone()); assert!(c.try_settle_price(&px,&101,&f.hash()).is_err());
    }
    f.e.mock_auths(&[]); assert!(c.try_settle_price(&px,&101,&f.hash()).is_err());
    assert_eq!(c.get_market(&ev).status,1); assert_eq!(c.get_market(&px).status,1);
    f.sign(&f.resolver,"settle_event",ev_args); c.settle_event(&ev,&0,&9000,&f.hash());
    f.sign(&f.resolver,"settle_price",px_args); c.settle_price(&px,&101,&f.hash());
    assert_eq!(c.get_market(&ev).status,2); assert_eq!(c.get_market(&px).status,2);
}
#[test]
fn claim_signed_by_someone_else_changes_nothing() {
    let f=Fixture::new(); let c=f.client(); let id=f.settled(); let args=(f.a.clone(),id);
    f.sign(&f.b,"claim",args.clone()); assert!(c.try_claim(&f.a,&id).is_err());
    f.sign(&f.resolver,"claim",args.clone()); assert!(c.try_claim(&f.a,&id).is_err());
    assert!(!c.get_position(&id,&f.a).unwrap().claimed); assert_eq!(f.balance(&f.a),900); assert_eq!(f.balance(&f.id),400);
    f.sign(&f.a,"claim",args); assert_eq!(c.claim(&f.a,&id),400); assert_eq!(f.balance(&f.a),1300);
}
#[test]
fn permit_entrypoints_reject_the_wrong_identity() {
    let f=Fixture::new(); let c=f.client(); let id=f.settled(); let keeper=Address::generate(&f.e);
    let grant=(f.a.clone(),keeper.clone(),300u64);
    f.sign(&keeper,"grant_claimer",grant.clone()); assert!(c.try_grant_claimer(&f.a,&keeper,&300).is_err());
    assert_eq!(c.get_claimer(&f.a),None);
    f.sign(&f.a,"grant_claimer",grant); c.grant_claimer(&f.a,&keeper,&300);
    let revoke=(f.a.clone(),);
    f.sign(&keeper,"revoke_claimer",revoke.clone()); assert!(c.try_revoke_claimer(&f.a).is_err());
    assert_eq!(c.get_claimer(&f.a).unwrap().keeper,keeper);
    let claim_for=(keeper.clone(),f.a.clone(),id);
    f.sign(&f.a,"claim_for",claim_for.clone()); assert!(c.try_claim_for(&keeper,&f.a,&id).is_err());
    assert!(!c.get_position(&id,&f.a).unwrap().claimed); assert_eq!(f.balance(&f.id),400);
    f.sign(&keeper,"claim_for",claim_for); assert_eq!(c.claim_for(&keeper,&f.a,&id),400);
    assert_eq!(f.balance(&f.a),1300); assert_eq!(f.balance(&keeper),0);
    f.sign(&f.a,"revoke_claimer",revoke); c.revoke_claimer(&f.a); assert_eq!(c.get_claimer(&f.a),None);
}
#[test]
fn revocation_and_regrant_cut_off_the_old_keeper_but_not_the_owner() {
    let f=Fixture::new(); let c=f.client(); let id=f.settled(); let k1=Address::generate(&f.e); let k2=Address::generate(&f.e);
    c.grant_claimer(&f.a,&k1,&300); c.revoke_claimer(&f.a);
    assert_eq!(c.try_claim_for(&k1,&f.a,&id),Err(Ok(Error::Denied.into())));
    c.revoke_claimer(&f.a); assert_eq!(c.get_claimer(&f.a),None); // revoking with no permit is a no-op
    c.grant_claimer(&f.a,&k1,&300); c.grant_claimer(&f.a,&k2,&400);
    assert_eq!(c.get_claimer(&f.a),Some(ClaimPermit{keeper:k2.clone(),expires_at:400}));
    assert_eq!(c.try_claim_for(&k1,&f.a,&id),Err(Ok(Error::Denied.into())));
    assert!(!c.get_position(&id,&f.a).unwrap().claimed); assert_eq!(f.balance(&f.id),400);
    c.revoke_claimer(&f.a); assert_eq!(c.claim(&f.a,&id),400);
    assert_eq!(f.balance(&f.a),1300); assert_eq!(f.balance(&k1),0); assert_eq!(f.balance(&k2),0);
}
#[test]
fn duplicate_claims_pay_once_across_claim_paths() {
    let f=Fixture::new(); let c=f.client(); let id=f.settled(); let keeper=Address::generate(&f.e);
    c.grant_claimer(&f.a,&keeper,&300); c.grant_claimer(&f.b,&keeper,&300);
    assert_eq!(c.claim(&f.a,&id),400);
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.try_claim_for(&keeper,&f.b,&id),Err(Ok(Error::Nothing.into()))); // loser
    assert_eq!(f.balance(&f.a),1300); assert_eq!(f.balance(&f.b),700); assert_eq!(f.balance(&f.id),0);
}
#[test]
fn timeout_refund_pays_once_across_claim_paths() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let keeper=Address::generate(&f.e);
    c.predict(&f.a,&id,&0,&100); c.predict(&f.b,&id,&1,&300); c.grant_claimer(&f.a,&keeper,&(100+MAX_PERMIT)); f.at(201+GRACE);
    assert_eq!(c.claim_for(&keeper,&f.a,&id),100);
    assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.try_claim_for(&keeper,&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.claim(&f.b,&id),300); assert_eq!(c.try_claim(&f.b,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.get_market(&id).status,3);
    assert_eq!(f.balance(&f.a),1000); assert_eq!(f.balance(&f.b),1000); assert_eq!(f.balance(&keeper),0); assert_eq!(f.balance(&f.id),0);
}
#[test]
fn settlement_timing_and_state_guards() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event); let outsider=Address::generate(&f.e);
    c.predict(&f.a,&id,&0,&100); c.predict(&f.b,&id,&1,&300);
    f.at(199); assert_eq!(c.try_request(&id),Err(Ok(Error::NotReady.into())));
    f.at(200); assert_eq!(c.try_settle_event(&id,&0,&9000,&f.hash()),Err(Ok(Error::NotReady.into()))); // not requested
    assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::NotReady.into())));
    f.at(200+GRACE); c.request(&id); assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::NotReady.into())));
    assert_eq!(c.get_market(&id).status,1); assert_eq!(f.balance(&f.id),400);
    c.settle_event(&id,&1,&9000,&f.hash()); // the deadline itself is still inside the window
    assert_eq!(c.try_settle_event(&id,&0,&9000,&f.hash()),Err(Ok(Error::NotReady.into())));
    assert_eq!(c.try_claim(&outsider,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(c.try_claim(&f.a,&id),Err(Ok(Error::Nothing.into())));
    assert_eq!(f.balance(&f.id),400);
    f.at(201+GRACE); assert_eq!(c.claim(&f.b,&id),400); assert_eq!(c.get_market(&id).outcome,1); // a late claim keeps the settled outcome
    assert_eq!(f.balance(&f.a),900); assert_eq!(f.balance(&f.b),1100); assert_eq!(f.balance(&f.id),0);
}
#[test]
fn late_request_is_rejected_and_market_falls_back_to_refund() {
    let f=Fixture::new(); let c=f.client(); let id=f.create(Kind::Event);
    c.predict(&f.a,&id,&0,&100); f.at(201+GRACE);
    assert_eq!(c.try_request(&id),Err(Ok(Error::NotReady.into())));
    assert_eq!(c.get_market(&id).status,0);
    assert_eq!(c.claim(&f.a,&id),100); assert_eq!(c.get_market(&id).status,3);
}
