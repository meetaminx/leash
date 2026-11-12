//! Wardly: a NEAR wallet contract that lets an AI agent spend, within limits
//! set by its owner.
//!
//! The agent can only ever call `request_payment`. Every request is checked
//! against the owner's rules on-chain:
//!   - the recipient must be on the owner's allowlist
//!   - no single payment may exceed `max_per_tx` (hard cap, always rejected)
//!   - payments above `approval_threshold` are held until the owner approves
//!   - automatic payments may not exceed `daily_limit` per UTC day
//!
//! If the agent is tricked by a prompt injection into paying an attacker,
//! these checks fail and the transaction is rejected, no matter what the
//! agent was told.

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const NS_PER_DAY: u64 = 86_400_000_000_000;
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(5);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Allowlist,
    Pending,
}

/// A payment above the approval threshold, waiting for the owner.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingPayment {
    pub id: U64,
    pub receiver: AccountId,
    pub amount: NearToken,
    pub memo: Option<String>,
    pub requested_at: U64,
}

/// What happened to a payment request that passed the rules.
#[near(serializers = [json])]
pub enum PaymentOutcome {
    /// Within limits: the transfer was sent.
    Sent,
    /// Above the approval threshold: held for the owner, with this id.
    PendingApproval { id: U64 },
}

/// The owner's current rules, as returned by `get_config`.
#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub agent: AccountId,
    pub max_per_tx: NearToken,
    pub daily_limit: NearToken,
    pub approval_threshold: NearToken,
    pub paused: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Wardly {
    owner: AccountId,
    agent: AccountId,
    max_per_tx: NearToken,
    daily_limit: NearToken,
    approval_threshold: NearToken,
    paused: bool,
    allowlist: IterableSet<AccountId>,
    pending: IterableMap<u64, PendingPayment>,
    next_pending_id: u64,
    /// UTC day index (days since epoch) that `spent_today` refers to.
    current_day: u64,
    spent_today: NearToken,
}

#[near]
impl Wardly {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        max_per_tx: NearToken,
        daily_limit: NearToken,
        approval_threshold: NearToken,
        recipients: Option<Vec<AccountId>>,
    ) -> Self {
        require!(owner != agent, "WARDLY: owner and agent must be different accounts");
        Self::assert_limits(max_per_tx, daily_limit, approval_threshold);
        let recipients = recipients.unwrap_or_default();
        require!(recipients.len() <= 50, "WARDLY: at most 50 recipients at setup");
        let mut allowlist = IterableSet::new(StorageKey::Allowlist);
        for r in recipients {
            allowlist.insert(r);
        }
        Self {
            owner,
            agent,
            max_per_tx,
            daily_limit,
            approval_threshold,
            paused: false,
            allowlist,
            pending: IterableMap::new(StorageKey::Pending),
            next_pending_id: 0,
            current_day: Self::today(),
            spent_today: NearToken::from_yoctonear(0),
        }
    }

    // ------------------------------------------------------------------
    // Agent
    // ------------------------------------------------------------------

    /// The only method the agent may call. Sends the payment if it is within
    /// the rules, holds it for approval if it is above the threshold, and
    /// rejects it (the transaction fails) otherwise.
    pub fn request_payment(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: Option<String>,
    ) -> PaymentOutcome {
        require!(
            env::predecessor_account_id() == self.agent,
            "WARDLY: only the agent can request payments"
        );
        require!(!self.paused, "WARDLY: wallet is paused by the owner");
        require!(!amount.is_zero(), "WARDLY: amount must be greater than zero");
        require!(
            self.allowlist.contains(&receiver),
            "WARDLY: recipient is not on the allowlist"
        );
        require!(
            amount <= self.max_per_tx,
            "WARDLY: amount exceeds the per-transaction limit"
        );
        if let Some(m) = &memo {
            require!(m.len() <= 256, "WARDLY: memo is too long");
        }

        if amount > self.approval_threshold {
            let id = self.next_pending_id;
            self.next_pending_id += 1;
            let payment = PendingPayment {
                id: U64(id),
                receiver: receiver.clone(),
                amount,
                memo,
                requested_at: U64(env::block_timestamp()),
            };
            self.pending.insert(id, payment);
            Self::log_event(
                "payment_pending",
                &format!(
                    r#"{{"id":"{}","receiver":"{}","amount":"{}"}}"#,
                    id,
                    receiver,
                    amount.as_yoctonear()
                ),
            );
            return PaymentOutcome::PendingApproval { id: U64(id) };
        }

        self.roll_day();
        let new_total = self
            .spent_today
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("WARDLY: overflow"));
        require!(
            new_total <= self.daily_limit,
            "WARDLY: payment would exceed the daily limit"
        );
        self.spent_today = new_total;

        self.send(receiver, amount, true).detach();
        PaymentOutcome::Sent
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// Approve a held payment. Approved payments are sent even if they would
    /// go over the daily limit, because the owner chose to send them.
    pub fn approve(&mut self, id: U64) -> Promise {
        self.assert_owner();
        let payment = self
            .pending
            .remove(&id.0)
            .unwrap_or_else(|| env::panic_str("WARDLY: no pending payment with that id"));
        require!(
            self.allowlist.contains(&payment.receiver),
            "WARDLY: recipient was removed from the allowlist"
        );
        Self::log_event(
            "payment_approved",
            &format!(r#"{{"id":"{}"}}"#, id.0),
        );
        self.send(payment.receiver, payment.amount, false)
    }

    pub fn reject(&mut self, id: U64) {
        self.assert_owner();
        require!(
            self.pending.remove(&id.0).is_some(),
            "WARDLY: no pending payment with that id"
        );
        Self::log_event("payment_rejected", &format!(r#"{{"id":"{}"}}"#, id.0));
    }

    pub fn add_recipient(&mut self, account: AccountId) {
        self.assert_owner();
        self.allowlist.insert(account);
    }

    pub fn remove_recipient(&mut self, account: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&account);
    }

    pub fn set_limits(
        &mut self,
        max_per_tx: NearToken,
        daily_limit: NearToken,
        approval_threshold: NearToken,
    ) {
        self.assert_owner();
        Self::assert_limits(max_per_tx, daily_limit, approval_threshold);
        self.max_per_tx = max_per_tx;
        self.daily_limit = daily_limit;
        self.approval_threshold = approval_threshold;
    }

    /// Replace the agent account, for example if its key was compromised.
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(agent != self.owner, "WARDLY: owner and agent must be different accounts");
        self.agent = agent;
    }

    /// Emergency stop: the agent can't spend anything until unpaused.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    /// Move funds back to the owner.
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        Promise::new(self.owner.clone()).transfer(amount)
    }

    // ------------------------------------------------------------------
    // Callback
    // ------------------------------------------------------------------

    /// If an automatic transfer failed (for example, the receiver account
    /// doesn't exist), give the amount back to today's allowance.
    #[private]
    pub fn on_transfer_complete(&mut self, amount: NearToken, day: u64) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) && day == self.current_day {
            self.spent_today = self.spent_today.saturating_sub(amount);
            Self::log_event(
                "payment_failed",
                &format!(r#"{{"amount":"{}"}}"#, amount.as_yoctonear()),
            );
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            max_per_tx: self.max_per_tx,
            daily_limit: self.daily_limit,
            approval_threshold: self.approval_threshold,
            paused: self.paused,
        }
    }

    /// How much the agent can still spend automatically today.
    pub fn get_remaining_today(&self) -> NearToken {
        if Self::today() != self.current_day {
            return self.daily_limit;
        }
        self.daily_limit.saturating_sub(self.spent_today)
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_pending(&self) -> Vec<PendingPayment> {
        self.pending.values().cloned().collect()
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    fn send(&self, receiver: AccountId, amount: NearToken, counts_toward_daily: bool) -> Promise {
        Self::log_event(
            "payment_sent",
            &format!(
                r#"{{"receiver":"{}","amount":"{}"}}"#,
                receiver,
                amount.as_yoctonear()
            ),
        );
        let transfer = Promise::new(receiver).transfer(amount);
        if counts_toward_daily {
            transfer.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_transfer_complete(amount, self.current_day),
            )
        } else {
            transfer
        }
    }

    fn roll_day(&mut self) {
        let today = Self::today();
        if today != self.current_day {
            self.current_day = today;
            self.spent_today = NearToken::from_yoctonear(0);
        }
    }

    fn today() -> u64 {
        env::block_timestamp() / NS_PER_DAY
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "WARDLY: only the owner can do this"
        );
    }

    fn assert_limits(max_per_tx: NearToken, daily_limit: NearToken, approval_threshold: NearToken) {
        require!(!max_per_tx.is_zero(), "WARDLY: max_per_tx must be greater than zero");
        require!(
            approval_threshold <= max_per_tx,
            "WARDLY: approval_threshold can't be above max_per_tx"
        );
        require!(
            approval_threshold <= daily_limit,
            "WARDLY: approval_threshold can't be above daily_limit"
        );
    }

    fn log_event(event: &str, data: &str) {
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"wardly","version":"1.0.0","event":"{}","data":[{}]}}"#,
            event, data
        ));
    }
}

#[cfg(test)]
mod tests;
