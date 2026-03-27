//! Pool account data decoders for publishing reserve state via Redis.
//! Supports Raydium AMM V4 and PumpSwap (constant-product AMMs).

use serde::Serialize;
use solana_sdk::pubkey::Pubkey;

#[derive(Serialize, Clone, Debug)]
pub struct PoolUpdate {
    pub p: String,  // pool address
    pub d: String,  // dex name
    pub ta: String, // token A mint
    pub tb: String, // token B mint
    pub ra: u64,    // reserve A (raw)
    pub rb: u64,    // reserve B (raw)
    pub px: f64,    // price (B per A, decimal-adjusted)
    pub ts: u64,    // timestamp ms
}

/// Known DEX program IDs
const RAYDIUM_AMM_V4: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMPSWAP_AMM: &str = "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP";
const PUMP_BONDING_CURVE: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/// Identify which DEX owns this account
pub fn identify_dex(owner: &[u8]) -> Option<&'static str> {
    if owner.len() != 32 { return None; }
    let owner_key = Pubkey::new_from_array({
        let mut arr = [0u8; 32];
        arr.copy_from_slice(owner);
        arr
    });
    let owner_str = owner_key.to_string();
    match owner_str.as_str() {
        RAYDIUM_AMM_V4 => Some("raydium"),
        PUMPSWAP_AMM => Some("pumpswap"),
        PUMP_BONDING_CURVE => Some("pump_curve"),
        _ => None,
    }
}

/// Decode pool account data into a publishable update.
/// Returns None if the data doesn't match expected layout.
pub fn decode_pool_update(pool_pubkey: &Pubkey, dex: &str, data: &[u8]) -> Option<PoolUpdate> {
    match dex {
        "raydium" => decode_raydium_amm_v4(pool_pubkey, data),
        "pumpswap" => decode_pumpswap(pool_pubkey, data),
        "pump_curve" => decode_pump_bonding_curve(pool_pubkey, data),
        _ => None,
    }
}

/// Raydium AMM V4 account layout (752 bytes):
/// Offset 0:   status (u64)
/// Offset 8:   nonce (u64)
/// Offset 16:  max_order (u64)
/// Offset 24:  depth (u64)
/// Offset 32:  base_decimal (u64)
/// Offset 40:  quote_decimal (u64)
/// Offset 48:  state (u64)
/// Offset 56:  reset_flag (u64)
/// Offset 64:  min_size (u64)
/// Offset 72:  vol_max_cut_ratio (u64)
/// Offset 80:  amount_wave_ratio (u64)
/// Offset 88:  base_lot_size (u64)
/// Offset 96:  quote_lot_size (u64)
/// Offset 104: min_price_multiplier (u64)
/// Offset 112: max_price_multiplier (u64)
/// Offset 120: system_decimal_value (u64)
/// ...fees...
/// Offset 168: min_separate_numerator (u64)
/// Offset 176: min_separate_denominator (u64)
/// Offset 184: trade_fee_numerator (u64)
/// Offset 192: trade_fee_denominator (u64)
/// Offset 200: pnl_numerator (u64)
/// Offset 208: pnl_denominator (u64)
/// Offset 216: swap_fee_numerator (u64)
/// Offset 224: swap_fee_denominator (u64)
/// Offset 232: base_need_take_pnl (u64)
/// Offset 240: quote_need_take_pnl (u64)
/// Offset 248: quote_total_pnl (u64)
/// Offset 256: base_total_pnl (u64)
/// ...
/// Offset 264: pool_open_time (u64)
/// ...padding...
/// Offset 336: base_vault (Pubkey, 32 bytes) — NOT reserves, this is the vault account address
/// Offset 368: quote_vault (Pubkey, 32 bytes)
/// Offset 400: base_mint (Pubkey, 32 bytes)
/// Offset 432: quote_mint (Pubkey, 32 bytes)
/// Offset 464: lp_mint (Pubkey, 32 bytes)
///
/// NOTE: The actual reserves are NOT stored directly in the AMM account.
/// They're in separate vault token accounts. However, we can get
/// `pool_coin_amount` and `pool_pc_amount` from need_take_pnl fields,
/// or we need to read the vault accounts. For a v1 approximation,
/// we'll extract the mints and use the total_pnl fields as rough indicators.
///
/// Actually, more useful: Raydium has `swap_base_in_amount` and
/// `swap_base_out_amount` in the state which are cumulative volume counters.
/// The real reserves require reading the vault accounts separately.
///
/// For v1, we'll extract: base_mint, quote_mint, and the fee structure.
/// The sniper can use these to know WHICH pools exist for a token,
/// even if we can't get exact reserves without vault reads.
fn decode_raydium_amm_v4(pool_pubkey: &Pubkey, data: &[u8]) -> Option<PoolUpdate> {
    // Raydium AMM V4 state is 752 bytes
    if data.len() < 496 { return None; }

    // Status: first u64, must be non-zero (active)
    let status = u64::from_le_bytes(data[0..8].try_into().ok()?);
    if status == 0 { return None; }

    let base_decimal = u64::from_le_bytes(data[32..40].try_into().ok()?);
    let quote_decimal = u64::from_le_bytes(data[40..48].try_into().ok()?);

    // Extract mints
    let base_mint = Pubkey::new_from_array(data[400..432].try_into().ok()?);
    let quote_mint = Pubkey::new_from_array(data[432..464].try_into().ok()?);

    // Use need_take_pnl as a proxy for reserves (imperfect but fast)
    // These represent accumulated fees — not actual reserves.
    // For a better v1: we publish the pool existence + mints,
    // and the sniper uses this to know a Raydium pool exists for a given token.
    let base_pnl = u64::from_le_bytes(data[256..264].try_into().ok()?);
    let quote_pnl = u64::from_le_bytes(data[248..256].try_into().ok()?);

    // Skip pools with zero activity
    if base_pnl == 0 && quote_pnl == 0 { return None; }

    let base_adj = 10f64.powi(base_decimal as i32);
    let quote_adj = 10f64.powi(quote_decimal as i32);

    // Price approximation — this is NOT accurate for trading decisions,
    // but signals pool existence and rough price level
    let px = if base_pnl > 0 {
        (quote_pnl as f64 / quote_adj) / (base_pnl as f64 / base_adj)
    } else {
        0.0
    };

    Some(PoolUpdate {
        p: pool_pubkey.to_string(),
        d: "raydium".to_string(),
        ta: base_mint.to_string(),
        tb: quote_mint.to_string(),
        ra: base_pnl,
        rb: quote_pnl,
        px,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

/// PumpSwap bonding curve account layout:
/// Much simpler — stores virtual reserves directly.
/// Offset 0:  discriminator (8 bytes)
/// Offset 8:  virtual_token_reserves (u64)
/// Offset 16: virtual_sol_reserves (u64)
/// Offset 24: real_token_reserves (u64)
/// Offset 32: real_sol_reserves (u64)
/// Offset 40: token_total_supply (u64)
/// Offset 48: complete (bool/u8) — whether bonding curve is complete
/// Offset 49: mint (Pubkey, 32 bytes)
fn decode_pumpswap(pool_pubkey: &Pubkey, data: &[u8]) -> Option<PoolUpdate> {
    if data.len() < 81 { return None; }

    let virtual_token = u64::from_le_bytes(data[8..16].try_into().ok()?);
    let virtual_sol = u64::from_le_bytes(data[16..24].try_into().ok()?);
    let real_token = u64::from_le_bytes(data[24..32].try_into().ok()?);
    let real_sol = u64::from_le_bytes(data[32..40].try_into().ok()?);
    let complete = data[48];

    // Skip completed bonding curves (migrated to Raydium)
    if complete != 0 { return None; }
    if real_token == 0 || real_sol == 0 { return None; }

    let mint = Pubkey::new_from_array(data[49..81].try_into().ok()?);
    let sol_mint = "So11111111111111111111111111111111111111112";

    // Price: SOL per token using virtual reserves (includes virtual liquidity)
    // Token has 6 decimals, SOL has 9 decimals
    let px = if virtual_token > 0 {
        (virtual_sol as f64 / 1e9) / (virtual_token as f64 / 1e6)
    } else {
        0.0
    };

    Some(PoolUpdate {
        p: pool_pubkey.to_string(),
        d: "pumpswap".to_string(),
        ta: mint.to_string(),
        tb: sol_mint.to_string(),
        ra: real_token,
        rb: real_sol,
        px,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

/// Pump.fun bonding curve — same layout, owned by Pump program
fn decode_pump_bonding_curve(pool_pubkey: &Pubkey, data: &[u8]) -> Option<PoolUpdate> {
    if data.len() < 81 { return None; }

    let virtual_token = u64::from_le_bytes(data[8..16].try_into().ok()?);
    let virtual_sol = u64::from_le_bytes(data[16..24].try_into().ok()?);
    let real_token = u64::from_le_bytes(data[24..32].try_into().ok()?);
    let real_sol = u64::from_le_bytes(data[32..40].try_into().ok()?);

    if real_token == 0 && real_sol == 0 { return None; }

    let mint = Pubkey::new_from_array(data[49..81].try_into().ok()?);
    let sol_mint = "So11111111111111111111111111111111111111112";

    let px = if virtual_token > 0 {
        (virtual_sol as f64 / 1e9) / (virtual_token as f64 / 1e6)
    } else {
        0.0
    };

    Some(PoolUpdate {
        p: pool_pubkey.to_string(),
        d: "pump_curve".to_string(),
        ta: mint.to_string(),
        tb: sol_mint.to_string(),
        ra: real_token,
        rb: real_sol,
        px,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}
