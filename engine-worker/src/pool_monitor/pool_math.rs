/// Constant product AMM math (x * y = k)
/// Used by Raydium AMM and standard Orca pools

/// Calculate output amount for a swap given constant product formula
/// amount_out = (reserve_out * amount_in) / (reserve_in + amount_in) * (1 - fee)
pub fn constant_product_swap(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u64, // fee in basis points (e.g., 25 = 0.25%)
) -> u64 {
    if reserve_in == 0 || reserve_out == 0 || amount_in == 0 {
        return 0;
    }
    let fee_factor = 10000 - fee_bps;
    let amount_in_with_fee = (amount_in as u128) * (fee_factor as u128);
    let numerator = amount_in_with_fee * (reserve_out as u128);
    let denominator = (reserve_in as u128) * 10000 + amount_in_with_fee;
    (numerator / denominator) as u64
}

/// Calculate price from reserves (adjusted for decimals)
pub fn price_from_reserves(
    reserve_a: u64,
    reserve_b: u64,
    decimals_a: u8,
    decimals_b: u8,
) -> f64 {
    if reserve_a == 0 {
        return 0.0;
    }
    let adj_a = reserve_a as f64 / 10_f64.powi(decimals_a as i32);
    let adj_b = reserve_b as f64 / 10_f64.powi(decimals_b as i32);
    adj_b / adj_a
}

/// Calculate the spread between two prices as a percentage
pub fn spread_pct(buy_price: f64, sell_price: f64) -> f64 {
    if buy_price <= 0.0 {
        return 0.0;
    }
    ((sell_price - buy_price) / buy_price) * 100.0
}

/// Estimate profit from a cross-DEX arb (buy on cheap DEX, sell on expensive DEX)
/// Returns (gross_profit_pct, net_profit_pct) after accounting for swap fees
pub fn estimate_cross_dex_profit(
    buy_reserve_in: u64,   // quote reserves on buy DEX
    buy_reserve_out: u64,  // token reserves on buy DEX
    sell_reserve_in: u64,  // token reserves on sell DEX
    sell_reserve_out: u64, // quote reserves on sell DEX
    amount_in: u64,        // quote amount to trade
    buy_fee_bps: u64,
    sell_fee_bps: u64,
) -> (f64, f64) {
    // Buy: quote → token on cheap DEX
    let tokens_received = constant_product_swap(amount_in, buy_reserve_in, buy_reserve_out, buy_fee_bps);
    if tokens_received == 0 {
        return (0.0, 0.0);
    }

    // Sell: token → quote on expensive DEX
    let quote_received = constant_product_swap(tokens_received, sell_reserve_in, sell_reserve_out, sell_fee_bps);

    let gross_pct = ((quote_received as f64 / amount_in as f64) - 1.0) * 100.0;
    // Net = gross minus gas costs (Jito tip + priority fee ~ 0.003% on $100 trade)
    let gas_pct = 0.003;
    let net_pct = gross_pct - gas_pct;

    (gross_pct, net_pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_product_basic() {
        // Pool: 1000 SOL, 100000 USDC, 0.25% fee
        // Swap 1 SOL → should get ~99.75 USDC (slightly less due to price impact)
        let out = constant_product_swap(
            1_000_000_000, // 1 SOL (9 decimals)
            1000_000_000_000, // 1000 SOL
            100000_000_000, // 100000 USDC (6 decimals)
            25, // 0.25%
        );
        // Expected: ~99.75 USDC minus price impact
        assert!(out > 99_000_000); // > 99 USDC
        assert!(out < 100_000_000); // < 100 USDC
    }

    #[test]
    fn test_price_from_reserves() {
        // 1000 SOL (9 dec), 100000 USDC (6 dec) → SOL price = 100 USDC
        let price = price_from_reserves(
            1000_000_000_000, // 1000 SOL
            100000_000_000,   // 100000 USDC
            9, 6,
        );
        assert!((price - 100.0).abs() < 0.01);
    }

    #[test]
    fn test_spread_calculation() {
        let spread = spread_pct(100.0, 100.5);
        assert!((spread - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_zero_reserves() {
        assert_eq!(constant_product_swap(100, 0, 100, 25), 0);
        assert_eq!(constant_product_swap(100, 100, 0, 25), 0);
        assert_eq!(constant_product_swap(0, 100, 100, 25), 0);
        assert_eq!(price_from_reserves(0, 100, 6, 6), 0.0);
    }
}
