use std::cmp::min_by;
use std::fmt;

/// Reference baseline metrics from the initial simulated liquidity pool creation.
const MARKET_CAP_REF: f64 = 1_000_000.0; // $1M Market Cap
const LIQUIDITY_REF: f64 = 100_000.0;    // $100k Liquidity
const TARGET_TVL: f64 = 500_000.0;       // $500k Target TVL
const MAX_TRADE_SIZE_SOL: f64 = 10.0;    // Safety limit

#[derive(Debug, Clone)]
pub struct MarketData {
    pub raydium_price_usdc: f64,
    pub orca_price_usdc: f64,
    pub market_cap: f64,
    pub liquidity_depth: f64,
    pub total_staked_tvl: f64,
    pub buys_24h: u64,
    pub sells_24h: u64,
}

impl MarketData {
    pub fn new_simulated() -> Self {
        MarketData {
            raydium_price_usdc: 0.045,
            orca_price_usdc: 0.045,
            market_cap: 4_500_000.0,
            liquidity_depth: 350_000.0,
            total_staked_tvl: 250_000.0,
            buys_24h: 1205,
            sells_24h: 340,
        }
    }
}

pub struct PricingEngine;

impl PricingEngine {
    /// Dynamically calculating trade size based on PRD specifications
    /// Trade size = baseUnit * (liquidityDepth / referenceLiquidity) * (marketCap / referenceMarketCap)
    pub fn calculate_trade_size(base_opportunity_size_sol: f64, data: &MarketData) -> f64 {
        let market_cap_ratio = data.market_cap / MARKET_CAP_REF;
        let liquidity_ratio = data.liquidity_depth / LIQUIDITY_REF;

        // Dynamic factor: as mcap grows, trade size increases, limited by liquidity
        let size_factor = market_cap_ratio.min(liquidity_ratio);

        // TVL factor: more staking TVL allows larger trades
        let tvl_factor = (data.total_staked_tvl / TARGET_TVL).min(1.0);

        let final_size = base_opportunity_size_sol * size_factor * tvl_factor;
        
        // Ensure we don't exceed max circuit breakers
        final_size.min(MAX_TRADE_SIZE_SOL)
    }

    /// Helper to evaluate alignment between Token Value (PCP) and USDC to identify Arb opportunities
    pub fn evaluate_alignment(dex_a_price: f64, dex_b_price: f64) -> f64 {
        // Simple percent difference
        let spread = (dex_a_price - dex_b_price).abs() / ((dex_a_price + dex_b_price) / 2.0);
        spread * 100.0
    }
}
