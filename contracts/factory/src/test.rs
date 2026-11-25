extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, Events, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, IntoVal, String};

fn setup() -> (Env, Address, Address) {
    let e = Env::default();
    let operator = Address::generate(&e);
    let id = e.register(RevMarketFactory, (operator.clone(),));
    (e, id, operator)
}

fn approve(
    e: &Env,
    id: &Address,
    who: &Address,
    version: u32,
    hash: &BytesN<32>,
) -> RevMarketFactoryClient<'static> {
    e.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: id,
            fn_name: "approve_version",
            args: (version, hash.clone()).into_val(e),
            sub_invokes: &[],
        },
    }]);
    RevMarketFactoryClient::new(e, id)
}

fn set_reviewer_auth(
    e: &Env,
    id: &Address,
    who: &Address,
    reviewer: &Address,
    enabled: bool,
) -> RevMarketFactoryClient<'static> {
    e.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: id,
            fn_name: "set_reviewer",
            args: (reviewer.clone(), enabled).into_val(e),
            sub_invokes: &[],
        },
    }]);
    RevMarketFactoryClient::new(e, id)
}

fn set_paused_auth(
    e: &Env,
    id: &Address,
    who: &Address,
    paused: bool,
) -> RevMarketFactoryClient<'static> {
    e.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: id,
            fn_name: "set_creation_paused",
            args: (paused,).into_val(e),
            sub_invokes: &[],
        },
    }]);
    RevMarketFactoryClient::new(e, id)
}

fn sample_params(e: &Env) -> MarketParams {
    // Rules digest matching docs/RULES_DIGEST.md Vector 1
    let rules_digest = BytesN::from_array(
        e,
        &[
            0x64, 0xe1, 0x54, 0xc9, 0x89, 0x88, 0x27, 0x65, 0x11, 0x53, 0xa9, 0x89, 0xe2, 0x8a,
            0x56, 0x74, 0xe8, 0xc9, 0x2c, 0x17, 0x92, 0x21, 0xb5, 0x52, 0x64, 0x78, 0x4d, 0x49,
            0x1c, 0x63, 0x06, 0xe9,
        ],
    );
    MarketParams {
        network_id: e.ledger().network_id(),
        rules_digest,
        metadata_cid: String::from_str(e, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"),
        collateral: Address::generate(e),
        closes_at: 1_800_000_000,
        resolution_deadline: 1_800_086_400,
        resolver: Address::generate(e),
        resolution_policy_hash: BytesN::from_array(e, &[9; 32]),
        fee_bps: 30,
    }
}

#[allow(clippy::too_many_arguments)]
fn create_market_dual_auth(
    e: &Env,
    id: &Address,
    creator: &Address,
    reviewer: &Address,
    version: u32,
    wasm_hash: &BytesN<32>,
    nonce: &BytesN<32>,
    approval_expires_at: u64,
    reviewer_epoch: u32,
    params: &MarketParams,
) -> RevMarketFactoryClient<'static> {
    let args = (
        creator.clone(),
        reviewer.clone(),
        version,
        wasm_hash.clone(),
        nonce.clone(),
        approval_expires_at,
        reviewer_epoch,
        params.clone(),
    )
        .into_val(e);
    e.mock_auths(&[
        MockAuth {
            address: creator,
            invoke: &MockAuthInvoke {
                contract: id,
                fn_name: "create_market",
                args: args.clone(),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: reviewer,
            invoke: &MockAuthInvoke {
                contract: id,
                fn_name: "create_market",
                args,
                sub_invokes: &[],
            },
        },
    ]);
    RevMarketFactoryClient::new(e, id)
}

#[test]
fn operator_registers_and_queries() {
    let (e, id, operator) = setup();
    let hash = BytesN::from_array(&e, &[7; 32]);
    let c = approve(&e, &id, &operator, 1, &hash);
    c.approve_version(&1, &hash);
    assert_eq!(
        e.events().all(),
        vec![
            &e,
            (
                id.clone(),
                (symbol_short!("approved"), 1u32).into_val(&e),
                hash.into_val(&e)
            )
        ]
    );
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
    assert!(approve(&e, &id, &stranger, 1, &hash)
        .try_approve_version(&1, &hash)
        .is_err());
    assert_eq!(c.get_version(&1), None);
}

#[test]
fn rejects_invalid_and_repeated_registration() {
    let (e, id, operator) = setup();
    let hash = BytesN::from_array(&e, &[7; 32]);
    let zero = BytesN::from_array(&e, &[0; 32]);
    assert_eq!(
        approve(&e, &id, &operator, 0, &hash).try_approve_version(&0, &hash),
        Err(Ok(Error::Invalid.into()))
    );
    assert_eq!(
        approve(&e, &id, &operator, 1, &zero).try_approve_version(&1, &zero),
        Err(Ok(Error::Invalid.into()))
    );
    approve(&e, &id, &operator, 1, &hash).approve_version(&1, &hash);
    assert_eq!(
        approve(&e, &id, &operator, 1, &hash).try_approve_version(&1, &hash),
        Err(Ok(Error::Duplicate.into()))
    );
    let other = BytesN::from_array(&e, &[8; 32]);
    assert_eq!(
        approve(&e, &id, &operator, 1, &other).try_approve_version(&1, &other),
        Err(Ok(Error::Duplicate.into()))
    );
    assert_eq!(RevMarketFactoryClient::new(&e, &id).get_version(&1), Some(hash));
}

#[test]
fn reviewed_fixture_deploys_once_and_rejects_replay() {
    let (e, id, operator) = setup();
    e.ledger().set_timestamp(1_700_000_000);
    let wasm_hash = BytesN::from_array(&e, &[7; 32]);
    approve(&e, &id, &operator, 1, &wasm_hash).approve_version(&1, &wasm_hash);

    let reviewer = Address::generate(&e);
    let role = set_reviewer_auth(&e, &id, &operator, &reviewer, true).set_reviewer(&reviewer, &true);
    assert_eq!(role, ReviewerRole { enabled: true, epoch: 1 });

    let creator = Address::generate(&e);
    let nonce = BytesN::from_array(&e, &[3; 32]);
    let expiry = 1_700_086_400;
    let params = sample_params(&e);

    let record = create_market_dual_auth(
        &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params,
    )
    .create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params);

    assert_eq!(record.creator, creator);
    assert_eq!(record.reviewer, reviewer);
    assert_eq!(record.reviewer_epoch, 1);
    assert_eq!(record.version, 1);
    assert_eq!(record.wasm_hash, wasm_hash);
    assert_eq!(record.rules_digest, params.rules_digest);

    let c = RevMarketFactoryClient::new(&e, &id);
    assert_eq!(c.get_market(&record.address), Some(record.clone()));
    assert_eq!(c.list_markets(&0, &10), vec![&e, record.clone()]);
    assert_eq!(c.get_nonce_state(&creator, &nonce), NonceState::Consumed);

    // Repeat submission with same (creator, nonce) must be safely rejected with no second market
    let replay = create_market_dual_auth(
        &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params,
    )
    .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params);
    assert_eq!(replay, Err(Ok(Error::NonceUsed.into())));
    assert_eq!(c.list_markets(&0, &10).len(), 1);
}

#[test]
fn rejects_wrong_revoked_expired_and_altered_inputs() {
    let (e, id, operator) = setup();
    e.ledger().set_timestamp(1_700_000_000);
    let wasm_hash = BytesN::from_array(&e, &[7; 32]);
    approve(&e, &id, &operator, 1, &wasm_hash).approve_version(&1, &wasm_hash);

    let reviewer = Address::generate(&e);
    set_reviewer_auth(&e, &id, &operator, &reviewer, true).set_reviewer(&reviewer, &true);

    let creator = Address::generate(&e);
    let nonce = BytesN::from_array(&e, &[4; 32]);
    let expiry = 1_700_086_400;
    let params = sample_params(&e);

    // 1. Self-review rejected
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &creator, 1, &wasm_hash, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &creator, &1, &wasm_hash, &nonce, &expiry, &1, &params),
        Err(Ok(Error::SelfReview.into()))
    );

    // 2. Missing reviewer auth rejected
    let args = (
        creator.clone(),
        reviewer.clone(),
        1u32,
        wasm_hash.clone(),
        nonce.clone(),
        expiry,
        1u32,
        params.clone(),
    )
        .into_val(&e);
    e.mock_auths(&[MockAuth {
        address: &creator,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "create_market",
            args,
            sub_invokes: &[],
        },
    }]);
    assert!(RevMarketFactoryClient::new(&e, &id)
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params)
        .is_err());

    // 3. Wrong network ID rejected
    let mut wrong_net = params.clone();
    wrong_net.network_id = BytesN::from_array(&e, &[1; 32]);
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &wrong_net
        )
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &wrong_net),
        Err(Ok(Error::WrongNetwork.into()))
    );

    // 4. Expired approval rejected
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, 1_700_000_000, 1, &params
        )
        .try_create_market(
            &creator,
            &reviewer,
            &1,
            &wasm_hash,
            &nonce,
            &1_700_000_000,
            &1,
            &params
        ),
        Err(Ok(Error::Expired.into()))
    );

    // 5. Mismatched WASM hash rejected
    let wrong_wasm = BytesN::from_array(&e, &[8; 32]);
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wrong_wasm, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &reviewer, &1, &wrong_wasm, &nonce, &expiry, &1, &params),
        Err(Ok(Error::WasmMismatch.into()))
    );

    // 6. Revoked reviewer and stale epoch after re-enable rejected
    let revoked =
        set_reviewer_auth(&e, &id, &operator, &reviewer, false).set_reviewer(&reviewer, &false);
    assert_eq!(revoked, ReviewerRole { enabled: false, epoch: 2 });
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params),
        Err(Ok(Error::UnauthorizedReviewer.into()))
    );
    let reenabled =
        set_reviewer_auth(&e, &id, &operator, &reviewer, true).set_reviewer(&reviewer, &true);
    assert_eq!(reenabled, ReviewerRole { enabled: true, epoch: 3 });
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params),
        Err(Ok(Error::UnauthorizedReviewer.into()))
    );

    // No partial deployment occurred
    let c = RevMarketFactoryClient::new(&e, &id);
    assert_eq!(c.list_markets(&0, &10).len(), 0);
    assert_eq!(c.get_nonce_state(&creator, &nonce), NonceState::Unused);
}

#[test]
fn pause_and_nonce_invalidation_prevent_deployment() {
    let (e, id, operator) = setup();
    e.ledger().set_timestamp(1_700_000_000);
    let wasm_hash = BytesN::from_array(&e, &[7; 32]);
    approve(&e, &id, &operator, 1, &wasm_hash).approve_version(&1, &wasm_hash);

    let reviewer = Address::generate(&e);
    set_reviewer_auth(&e, &id, &operator, &reviewer, true).set_reviewer(&reviewer, &true);

    let creator = Address::generate(&e);
    let nonce = BytesN::from_array(&e, &[5; 32]);
    let expiry = 1_700_086_400;
    let params = sample_params(&e);

    // Paused factory rejects creation
    set_paused_auth(&e, &id, &operator, true).set_creation_paused(&true);
    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params),
        Err(Ok(Error::Paused.into()))
    );
    set_paused_auth(&e, &id, &operator, false).set_creation_paused(&false);

    // Creator invalidates nonce before execution
    e.mock_auths(&[MockAuth {
        address: &creator,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "invalidate_creation_nonce",
            args: (creator.clone(), nonce.clone()).into_val(&e),
            sub_invokes: &[],
        },
    }]);
    RevMarketFactoryClient::new(&e, &id).invalidate_creation_nonce(&creator, &nonce);

    assert_eq!(
        create_market_dual_auth(
            &e, &id, &creator, &reviewer, 1, &wasm_hash, &nonce, expiry, 1, &params
        )
        .try_create_market(&creator, &reviewer, &1, &wasm_hash, &nonce, &expiry, &1, &params),
        Err(Ok(Error::NonceInvalidated.into()))
    );
    assert_eq!(
        RevMarketFactoryClient::new(&e, &id).list_markets(&0, &10).len(),
        0
    );
}
