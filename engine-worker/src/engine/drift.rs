//! Drift Protocol instruction builder
//! Builds instructions for perp trading directly from Anchor IDL format.
//! Program ID: dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH

use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
    sysvar::rent,
};
use sha2::{Sha256, Digest};
use std::str::FromStr;

const DRIFT_PROGRAM_ID: &str = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";

/// Drift state account (singleton)
const DRIFT_STATE: &str = "FExhvPycCCwYnZGeDsVtLhpEQ3yEkVY4YpLAcJBBEMvs";

/// Get the Drift program ID
pub fn program_id() -> Pubkey {
    Pubkey::from_str(DRIFT_PROGRAM_ID).unwrap()
}

/// Compute Anchor 8-byte discriminator: sha256("global:<method_name>")[..8]
fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{}", name));
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

// --- PDA Derivations ---

/// Derive user account PDA: seeds = ["user", authority, sub_account_id_le]
pub fn derive_user_account(authority: &Pubkey, sub_account_id: u16) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(
        &[b"user", authority.as_ref(), &sub_account_id.to_le_bytes()],
        &program_id(),
    );
    pda
}

/// Derive user stats PDA: seeds = ["user_stats", authority]
pub fn derive_user_stats(authority: &Pubkey) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(
        &[b"user_stats", authority.as_ref()],
        &program_id(),
    );
    pda
}

/// Derive perp market PDA: seeds = ["perp_market", market_index_le]
pub fn derive_perp_market(market_index: u16) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(
        &[b"perp_market", &market_index.to_le_bytes()],
        &program_id(),
    );
    pda
}

// --- Enums (Borsh-serialized as u8 variant index) ---

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum OrderType {
    Market = 0,
    Limit = 1,
    TriggerMarket = 2,
    TriggerLimit = 3,
    Oracle = 4,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum PositionDirection {
    Long = 0,
    Short = 1,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum MarketType {
    Spot = 0,
    Perp = 1,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum PostOnlyParam {
    None = 0,
    MustPostOnly = 1,
    TryPostOnly = 2,
    Slide = 3,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum OrderTriggerCondition {
    Above = 0,
    Below = 1,
    TriggeredAbove = 2,
    TriggeredBelow = 3,
}

// --- OrderParams serialization ---

/// Serialize OrderParams to bytes (Borsh format matching Drift IDL)
pub struct OrderParams {
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub direction: PositionDirection,
    pub user_order_id: u8,
    pub base_asset_amount: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: PostOnlyParam,
    pub bit_flags: u8,
    pub max_ts: Option<i64>,
    pub trigger_price: Option<u64>,
    pub trigger_condition: OrderTriggerCondition,
    pub oracle_price_offset: Option<i32>,
    pub auction_duration: Option<u8>,
    pub auction_start_price: Option<i64>,
    pub auction_end_price: Option<i64>,
}

impl OrderParams {
    /// Create a simple market order for perps
    pub fn market_order(
        direction: PositionDirection,
        base_asset_amount: u64,
        market_index: u16,
    ) -> Self {
        Self {
            order_type: OrderType::Market,
            market_type: MarketType::Perp,
            direction,
            user_order_id: 0,
            base_asset_amount,
            price: 0, // Market order — no price limit
            market_index,
            reduce_only: false,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            max_ts: None,
            trigger_price: None,
            trigger_condition: OrderTriggerCondition::Above,
            oracle_price_offset: None,
            auction_duration: None,
            auction_start_price: None,
            auction_end_price: None,
        }
    }

    /// Create a reduce-only market order (for closing positions)
    pub fn close_position(
        direction: PositionDirection,
        base_asset_amount: u64,
        market_index: u16,
    ) -> Self {
        let mut params = Self::market_order(direction, base_asset_amount, market_index);
        params.reduce_only = true;
        params
    }

    /// Serialize to Borsh bytes
    fn serialize(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(128);
        buf.push(self.order_type as u8);
        buf.push(self.market_type as u8);
        buf.push(self.direction as u8);
        buf.push(self.user_order_id);
        buf.extend_from_slice(&self.base_asset_amount.to_le_bytes());
        buf.extend_from_slice(&self.price.to_le_bytes());
        buf.extend_from_slice(&self.market_index.to_le_bytes());
        buf.push(self.reduce_only as u8);
        buf.push(self.post_only as u8);
        buf.push(self.bit_flags);
        // Option<i64> max_ts
        match self.max_ts {
            Some(v) => { buf.push(1); buf.extend_from_slice(&v.to_le_bytes()); }
            None => buf.push(0),
        }
        // Option<u64> trigger_price
        match self.trigger_price {
            Some(v) => { buf.push(1); buf.extend_from_slice(&v.to_le_bytes()); }
            None => buf.push(0),
        }
        buf.push(self.trigger_condition as u8);
        // Option<i32> oracle_price_offset
        match self.oracle_price_offset {
            Some(v) => { buf.push(1); buf.extend_from_slice(&v.to_le_bytes()); }
            None => buf.push(0),
        }
        // Option<u8> auction_duration
        match self.auction_duration {
            Some(v) => { buf.push(1); buf.push(v); }
            None => buf.push(0),
        }
        // Option<i64> auction_start_price
        match self.auction_start_price {
            Some(v) => { buf.push(1); buf.extend_from_slice(&v.to_le_bytes()); }
            None => buf.push(0),
        }
        // Option<i64> auction_end_price
        match self.auction_end_price {
            Some(v) => { buf.push(1); buf.extend_from_slice(&v.to_le_bytes()); }
            None => buf.push(0),
        }
        buf
    }
}

// --- Instruction Builders ---

/// Build a `placePerpOrder` instruction
/// Accounts: state (read), user (write), authority (signer)
pub fn place_perp_order(
    authority: &Pubkey,
    sub_account_id: u16,
    params: OrderParams,
) -> Instruction {
    let state = Pubkey::from_str(DRIFT_STATE).unwrap();
    let user = derive_user_account(authority, sub_account_id);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("place_perp_order"));
    data.extend_from_slice(&params.serialize());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(state, false),
            AccountMeta::new(user, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Build a `cancelOrder` instruction
/// Accounts: state (read), user (write), authority (signer)
pub fn cancel_order(
    authority: &Pubkey,
    sub_account_id: u16,
    order_id: Option<u32>,
) -> Instruction {
    let state = Pubkey::from_str(DRIFT_STATE).unwrap();
    let user = derive_user_account(authority, sub_account_id);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("cancel_order"));
    match order_id {
        Some(id) => { data.push(1); data.extend_from_slice(&id.to_le_bytes()); }
        None => data.push(0),
    }

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(state, false),
            AccountMeta::new(user, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Build `initializeUserStats` instruction
pub fn initialize_user_stats(authority: &Pubkey, payer: &Pubkey) -> Instruction {
    let state = Pubkey::from_str(DRIFT_STATE).unwrap();
    let user_stats = derive_user_stats(authority);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("initialize_user_stats"));

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(user_stats, false),
            AccountMeta::new(state, false),
            AccountMeta::new_readonly(*authority, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

/// Build `initializeUser` instruction
pub fn initialize_user(
    authority: &Pubkey,
    payer: &Pubkey,
    sub_account_id: u16,
    name: [u8; 32],
) -> Instruction {
    let state = Pubkey::from_str(DRIFT_STATE).unwrap();
    let user = derive_user_account(authority, sub_account_id);
    let user_stats = derive_user_stats(authority);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("initialize_user"));
    data.extend_from_slice(&sub_account_id.to_le_bytes());
    data.extend_from_slice(&name);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(user, false),
            AccountMeta::new(user_stats, false),
            AccountMeta::new(state, false),
            AccountMeta::new_readonly(*authority, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discriminator_place_perp_order() {
        let disc = discriminator("place_perp_order");
        assert_eq!(disc.len(), 8);
        // Should be deterministic
        assert_eq!(disc, discriminator("place_perp_order"));
        // Different from other instructions
        assert_ne!(disc, discriminator("cancel_order"));
    }

    #[test]
    fn test_derive_user_account() {
        let authority = Pubkey::new_unique();
        let user0 = derive_user_account(&authority, 0);
        let user1 = derive_user_account(&authority, 1);
        // Different sub-accounts produce different PDAs
        assert_ne!(user0, user1);
        // Same inputs produce same PDA
        assert_eq!(user0, derive_user_account(&authority, 0));
    }

    #[test]
    fn test_derive_perp_market() {
        let sol_perp = derive_perp_market(0);
        let btc_perp = derive_perp_market(1);
        assert_ne!(sol_perp, btc_perp);
    }

    #[test]
    fn test_market_order_serialization() {
        let params = OrderParams::market_order(
            PositionDirection::Short,
            1_000_000_000, // 1 SOL in base units
            0, // SOL-PERP
        );
        let bytes = params.serialize();
        // First byte: OrderType::Market = 0
        assert_eq!(bytes[0], 0);
        // Second byte: MarketType::Perp = 1
        assert_eq!(bytes[1], 1);
        // Third byte: PositionDirection::Short = 1
        assert_eq!(bytes[2], 1);
    }

    #[test]
    fn test_place_perp_order_instruction() {
        let authority = Pubkey::new_unique();
        let params = OrderParams::market_order(PositionDirection::Short, 1_000_000_000, 0);
        let ix = place_perp_order(&authority, 0, params);

        assert_eq!(ix.program_id, program_id());
        assert_eq!(ix.accounts.len(), 3); // state, user, authority
        assert!(!ix.accounts[0].is_writable); // state is read-only
        assert!(ix.accounts[1].is_writable); // user is writable
        assert!(ix.accounts[2].is_signer); // authority is signer
        assert!(ix.data.len() > 8); // discriminator + params
    }

    #[test]
    fn test_close_position_is_reduce_only() {
        let params = OrderParams::close_position(PositionDirection::Long, 500_000_000, 0);
        assert!(params.reduce_only);
    }
}
