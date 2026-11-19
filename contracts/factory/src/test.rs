extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, Events, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, IntoVal};

fn setup() -> (Env, Address, Address) {
    let e = Env::default();
    let operator = Address::generate(&e);
    let id = e.register(RevMarketFactory, (operator.clone(),));
    (e, id, operator)
}

fn approve(e: &Env, id: &Address, who: &Address, version: u32, hash: &BytesN<32>) -> RevMarketFactoryClient<'static> {
    e.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke { contract: id, fn_name: "approve_version", args: (version, hash.clone()).into_val(e), sub_invokes: &[] },
    }]);
    RevMarketFactoryClient::new(e, id)
}

#[test]
fn operator_registers_and_queries() {
    let (e, id, operator) = setup();
    let hash = BytesN::from_array(&e, &[7; 32]);
    let c = approve(&e, &id, &operator, 1, &hash);
    c.approve_version(&1, &hash);
    assert_eq!(e.events().all(), vec![&e, (id.clone(), (symbol_short!("approved"), 1u32).into_val(&e), hash.into_val(&e))]);
    assert_eq!(c.get_version(&1), Some(hash));
    assert_eq!(c.get_version(&2), None);
}

#[test]
fn rejects_without_operator_auth() {
    let (e, id, _operator) = setup();
    let hash = BytesN::from_array(&e, &[7; 32]);
    let c = RevMarketFactoryClient::new(&e, &id);
    assert!(c.try_approve_version(&1, &hash).is_err());
    let stranger = Address::generate(&e);
    assert!(approve(&e, &id, &stranger, 1, &hash).try_approve_version(&1, &hash).is_err());
    assert_eq!(c.get_version(&1), None);
}

#[test]
fn rejects_invalid_and_repeated_registration() {
    let (e, id, operator) = setup();
    let hash = BytesN::from_array(&e, &[7; 32]);
    let zero = BytesN::from_array(&e, &[0; 32]);
    assert_eq!(approve(&e, &id, &operator, 0, &hash).try_approve_version(&0, &hash), Err(Ok(Error::Invalid.into())));
    assert_eq!(approve(&e, &id, &operator, 1, &zero).try_approve_version(&1, &zero), Err(Ok(Error::Invalid.into())));
    approve(&e, &id, &operator, 1, &hash).approve_version(&1, &hash);
    assert_eq!(approve(&e, &id, &operator, 1, &hash).try_approve_version(&1, &hash), Err(Ok(Error::Duplicate.into())));
    let other = BytesN::from_array(&e, &[8; 32]);
    assert_eq!(approve(&e, &id, &operator, 1, &other).try_approve_version(&1, &other), Err(Ok(Error::Duplicate.into())));
    assert_eq!(RevMarketFactoryClient::new(&e, &id).get_version(&1), Some(hash));
}
