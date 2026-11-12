//! Wardly factory: creates a personal Wardly wallet in one transaction.
//!
//! Calling `create_wallet` with a name like "alice" creates the account
//! `alice.<factory>`, deploys the Wardly contract to it, and sets it up with
//! the caller as owner, plus the agent, limits and approved recipients they
//! chose. The attached deposit pays for the contract's storage, and the rest
//! becomes the wallet's first balance.
//!
//! If anything fails (for example the name is taken), the deposit is sent
//! back to the caller.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

/// The compiled Wardly contract. Build `contract/` first (see README).
#[cfg(not(test))]
const WARDLY_CODE: &[u8] = include_bytes!("../../contract/target/near/wardly.wasm");
#[cfg(test)]
const WARDLY_CODE: &[u8] = &[0u8; 1000];

const GAS_FOR_INIT: Gas = Gas::from_tgas(30);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
/// Extra deposit on top of code storage, for the wallet's state and a little headroom.
const EXTRA_DEPOSIT: NearToken = NearToken::from_millinear(200);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    ByOwner,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WardlyFactory {
    by_owner: LookupMap<AccountId, Vec<AccountId>>,
    total_created: u64,
}

#[near]
impl WardlyFactory {
    #[init]
    pub fn new() -> Self {
        Self {
            by_owner: LookupMap::new(StorageKey::ByOwner),
            total_created: 0,
        }
    }

    /// Create `<name>.<factory>` as a Wardly wallet owned by the caller.
    /// Attach at least `get_min_deposit()`. Attach 150 Tgas or more.
    #[payable]
    pub fn create_wallet(
        &mut self,
        name: String,
        agent: AccountId,
        max_per_tx: NearToken,
        daily_limit: NearToken,
        approval_threshold: NearToken,
        recipients: Option<Vec<AccountId>>,
    ) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(
            deposit >= self.get_min_deposit(),
            format!(
                "FACTORY: attach at least {} yoctoNEAR to cover the wallet's storage",
                self.get_min_deposit().as_yoctonear()
            )
        );
        let wallet_id = Self::wallet_account_id(&name);
        require!(owner != agent, "FACTORY: owner and agent must be different accounts");

        let init_args = near_sdk::serde_json::json!({
            "owner": owner,
            "agent": agent,
            "max_per_tx": max_per_tx,
            "daily_limit": daily_limit,
            "approval_threshold": approval_threshold,
            "recipients": recipients,
        });

        Promise::new(wallet_id.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(WARDLY_CODE.to_vec())
            .function_call(
                "new".to_string(),
                init_args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_wallet_created(wallet_id, owner, U128(deposit.as_yoctonear())),
            )
    }

    /// Records the new wallet, or refunds the caller if creation failed.
    #[private]
    pub fn on_wallet_created(&mut self, wallet_id: AccountId, owner: AccountId, deposit: U128) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok()
            || matches!(env::promise_result_checked(0, 0), Err(PromiseError::TooLong(_)));
        if ok {
            let mut list = self.by_owner.get(&owner).cloned().unwrap_or_default();
            list.push(wallet_id.clone());
            self.by_owner.insert(owner, list);
            self.total_created += 1;
            env::log_str(&format!(
                r#"EVENT_JSON:{{"standard":"wardly-factory","version":"1.0.0","event":"wallet_created","data":[{{"wardly":"{}"}}]}}"#,
                wallet_id
            ));
            true
        } else {
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            env::log_str(&format!("FACTORY: could not create {wallet_id}, deposit refunded"));
            false
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Smallest deposit `create_wallet` accepts: storage for the contract code plus headroom.
    pub fn get_min_deposit(&self) -> NearToken {
        env::storage_byte_cost()
            .saturating_mul(WARDLY_CODE.len() as u128)
            .saturating_add(EXTRA_DEPOSIT)
    }

    /// The account a given name would get, e.g. "alice" -> "alice.factory.testnet".
    pub fn get_wallet_account_id(&self, name: String) -> AccountId {
        Self::wallet_account_id(&name)
    }

    pub fn get_wallets(&self, owner: AccountId) -> Vec<AccountId> {
        self.by_owner.get(&owner).cloned().unwrap_or_default()
    }

    pub fn get_total_created(&self) -> u64 {
        self.total_created
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    fn wallet_account_id(name: &str) -> AccountId {
        require!(
            (2..=32).contains(&name.len()),
            "FACTORY: name must be 2 to 32 characters"
        );
        require!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
            "FACTORY: name can only use lowercase letters, numbers, - and _"
        );
        require!(
            !name.starts_with(['-', '_']) && !name.ends_with(['-', '_']),
            "FACTORY: name can't start or end with - or _"
        );
        format!("{}.{}", name, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("FACTORY: that name doesn't make a valid account"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn bot() -> AccountId {
        "bot.testnet".parse().unwrap()
    }

    fn ctx(caller: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("factory.testnet".parse().unwrap())
            .predecessor_account_id(caller)
            .attached_deposit(deposit)
            .build());
    }

    fn callback_ctx(result: PromiseResult) {
        let c = VMContextBuilder::new()
            .current_account_id("factory.testnet".parse().unwrap())
            .predecessor_account_id("factory.testnet".parse().unwrap())
            .build();
        testing_env!(
            c,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn create(f: &mut WardlyFactory, name: &str) {
        f.create_wallet(
            name.to_string(),
            bot(),
            NearToken::from_near(1),
            NearToken::from_near(2),
            NearToken::from_millinear(500),
            Some(vec!["shop.testnet".parse().unwrap()]),
        )
        .detach();
    }

    #[test]
    fn names_map_to_subaccounts() {
        ctx(alice(), NearToken::from_near(0));
        let f = WardlyFactory::new();
        assert_eq!(f.get_wallet_account_id("alice".into()).as_str(), "alice.factory.testnet");
    }

    #[test]
    fn min_deposit_covers_code_storage() {
        ctx(alice(), NearToken::from_near(0));
        let f = WardlyFactory::new();
        let code_cost = env::storage_byte_cost().saturating_mul(WARDLY_CODE.len() as u128);
        assert!(f.get_min_deposit() > code_cost);
    }

    #[test]
    fn create_with_enough_deposit_is_accepted() {
        ctx(alice(), NearToken::from_near(3));
        let mut f = WardlyFactory::new();
        create(&mut f, "alice-bot");
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn create_without_deposit_is_rejected() {
        ctx(alice(), NearToken::from_yoctonear(1));
        let mut f = WardlyFactory::new();
        create(&mut f, "alice");
    }

    #[test]
    #[should_panic(expected = "lowercase letters")]
    fn uppercase_names_are_rejected() {
        ctx(alice(), NearToken::from_near(3));
        let mut f = WardlyFactory::new();
        create(&mut f, "Alice");
    }

    #[test]
    #[should_panic(expected = "can't start or end")]
    fn names_with_edge_dashes_are_rejected() {
        ctx(alice(), NearToken::from_near(3));
        let mut f = WardlyFactory::new();
        create(&mut f, "-alice");
    }

    #[test]
    #[should_panic(expected = "owner and agent must be different")]
    fn owner_cannot_be_the_agent() {
        ctx(bot(), NearToken::from_near(3));
        let mut f = WardlyFactory::new();
        create(&mut f, "bot");
    }

    #[test]
    fn success_is_recorded_for_the_owner() {
        ctx(alice(), NearToken::from_near(0));
        let mut f = WardlyFactory::new();
        callback_ctx(PromiseResult::Successful(vec![]));
        let ok = f.on_wallet_created("alice.factory.testnet".parse().unwrap(), alice(), U128(1));
        assert!(ok);
        assert_eq!(f.get_wallets(alice()), vec!["alice.factory.testnet".parse::<AccountId>().unwrap()]);
        assert_eq!(f.get_total_created(), 1);
    }

    #[test]
    fn failure_is_not_recorded() {
        ctx(alice(), NearToken::from_near(0));
        let mut f = WardlyFactory::new();
        callback_ctx(PromiseResult::Failed);
        let ok = f.on_wallet_created("alice.factory.testnet".parse().unwrap(), alice(), U128(1));
        assert!(!ok);
        assert!(f.get_wallets(alice()).is_empty());
        assert_eq!(f.get_total_created(), 0);
    }
}
