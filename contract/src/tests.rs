use super::*;
use near_sdk::PromiseResult;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

const DAY: u64 = NS_PER_DAY;

fn owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.near".parse().unwrap()
}
fn shop() -> AccountId {
    "shop.near".parse().unwrap()
}
fn attacker() -> AccountId {
    "attacker.near".parse().unwrap()
}
fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn set_caller(caller: AccountId, timestamp: u64) {
    let ctx = VMContextBuilder::new()
        .current_account_id("wardly.near".parse().unwrap())
        .predecessor_account_id(caller)
        .block_timestamp(timestamp)
        .account_balance(near(100))
        .build();
    testing_env!(ctx);
}

/// Wallet with: max 5 NEAR per payment, 10 NEAR per day, owner approval
/// above 2 NEAR, and shop.near on the allowlist.
fn setup() -> Wardly {
    set_caller(owner(), DAY * 1000);
    let mut c = Wardly::new(owner(), agent(), near(5), near(10), near(2), None);
    c.add_recipient(shop());
    c
}

#[test]
fn agent_can_pay_allowlisted_recipient_within_limits() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    let out = c.request_payment(shop(), near(1), Some("coffee beans".into()));
    assert!(matches!(out, PaymentOutcome::Sent));
    assert_eq!(c.get_remaining_today(), near(9));
}

#[test]
#[should_panic(expected = "recipient is not on the allowlist")]
fn prompt_injection_payment_to_attacker_is_rejected() {
    // The agent has been tricked into paying an account the owner never
    // approved. The contract refuses, whatever the agent was told.
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(attacker(), near(1), Some("urgent refund".into()));
}

#[test]
#[should_panic(expected = "exceeds the per-transaction limit")]
fn payment_above_hard_cap_is_rejected() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(6), None);
}

#[test]
#[should_panic(expected = "would exceed the daily limit")]
fn daily_limit_is_enforced() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    for _ in 0..5 {
        c.request_payment(shop(), near(2), None);
    }
    // 10 NEAR spent; one more yoctoNEAR is too much.
    c.request_payment(shop(), NearToken::from_yoctonear(1), None);
}

#[test]
fn daily_limit_resets_the_next_day() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    for _ in 0..5 {
        c.request_payment(shop(), near(2), None);
    }
    assert_eq!(c.get_remaining_today(), near(0));

    set_caller(agent(), DAY * 1001);
    assert_eq!(c.get_remaining_today(), near(10));
    let out = c.request_payment(shop(), near(2), None);
    assert!(matches!(out, PaymentOutcome::Sent));
    assert_eq!(c.get_remaining_today(), near(8));
}

#[test]
fn payment_above_threshold_waits_for_owner() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    let out = c.request_payment(shop(), near(4), None);
    let id = match out {
        PaymentOutcome::PendingApproval { id } => id,
        _ => panic!("expected a pending payment"),
    };
    // Held payments don't use up the daily allowance.
    assert_eq!(c.get_remaining_today(), near(10));
    assert_eq!(c.get_pending().len(), 1);

    set_caller(owner(), DAY * 1000);
    c.approve(id).detach();
    assert!(c.get_pending().is_empty());
}

#[test]
fn owner_can_reject_held_payment() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(4), None);
    set_caller(owner(), DAY * 1000);
    c.reject(U64(0));
    assert!(c.get_pending().is_empty());
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_approve_its_own_payment() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(4), None);
    c.approve(U64(0)).detach();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_add_attacker_to_allowlist() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.add_recipient(attacker());
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_raise_its_own_limits() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.set_limits(near(100), near(100), near(100));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_withdraw() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.withdraw(near(1)).detach();
}

#[test]
#[should_panic(expected = "only the agent can request payments")]
fn strangers_cannot_request_payments() {
    let mut c = setup();
    set_caller(attacker(), DAY * 1000);
    c.request_payment(shop(), near(1), None);
}

#[test]
#[should_panic(expected = "wallet is paused")]
fn paused_wallet_blocks_all_agent_payments() {
    let mut c = setup();
    set_caller(owner(), DAY * 1000);
    c.pause();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(1), None);
}

#[test]
#[should_panic(expected = "recipient was removed from the allowlist")]
fn approval_fails_if_recipient_was_removed() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(4), None);
    set_caller(owner(), DAY * 1000);
    c.remove_recipient(shop());
    c.approve(U64(0)).detach();
}

#[test]
#[should_panic(expected = "approval_threshold can't be above max_per_tx")]
fn init_rejects_inconsistent_limits() {
    set_caller(owner(), DAY * 1000);
    Wardly::new(owner(), agent(), near(1), near(10), near(2), None);
}

#[test]
fn failed_transfer_gives_allowance_back() {
    let mut c = setup();
    set_caller(agent(), DAY * 1000);
    c.request_payment(shop(), near(2), None);
    assert_eq!(c.get_remaining_today(), near(8));

    let ctx = VMContextBuilder::new()
        .current_account_id("wardly.near".parse().unwrap())
        .predecessor_account_id("wardly.near".parse().unwrap())
        .block_timestamp(DAY * 1000)
        .build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    c.on_transfer_complete(near(2), 1000);
    assert_eq!(c.get_remaining_today(), near(10));
}

#[test]
fn recipients_can_be_set_at_creation() {
    set_caller(owner(), DAY * 1000);
    let c = Wardly::new(owner(), agent(), near(5), near(10), near(2), Some(vec![shop(), "api.near".parse().unwrap()]));
    let list = c.get_allowlist();
    assert_eq!(list.len(), 2);
    assert!(list.contains(&shop()));
}
