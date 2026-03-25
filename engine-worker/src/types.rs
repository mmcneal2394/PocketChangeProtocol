use rust_decimal::Decimal;
use serde::{Serialize, Deserialize};
use solana_sdk::instruction::Instruction;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineMode { Paper, Devnet, Mainnet }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind { Triangular, CexDex, FlashLoan, FundingRate, Statistical }

impl std::fmt::Display for StrategyKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Triangular => write!(f, "triangular"),
            Self::CexDex => write!(f, "cex_dex"),
            Self::FlashLoan => write!(f, "flash_loan"),
            Self::FundingRate => write!(f, "funding_rate"),
            Self::Statistical => write!(f, "statistical"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Opportunity {
    pub id: String,
    pub strategy: StrategyKind,
    pub route: String,
    pub expected_profit_pct: Decimal,
    pub estimated_fees_pct: Decimal,
    pub trade_size_usdc: Decimal,
    #[serde(skip)]
    pub instructions: Vec<Instruction>,
    #[serde(skip, default = "Instant::now")]
    pub detected_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeResult {
    pub opportunity_id: String,
    pub success: bool,
    pub tx_hash: Option<String>,
    pub actual_profit_sol: Option<Decimal>,
    pub execution_time_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PriceSnapshot {
    pub mint: String,
    pub price_usdc: f64,
    pub source: String,
    pub timestamp: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalStatus { Pending, Approved, Rejected, Expired, Executed }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivePosition {
    pub id: String,
    pub strategy: StrategyKind,
    pub pair: String,
    pub status: PositionStatus,
    pub entry_price: Decimal,
    pub size_sol: Decimal,
    pub target_price: Option<Decimal>,
    pub stop_loss: Option<Decimal>,
    #[serde(skip, default = "Instant::now")]
    pub opened_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionStatus { Open, Closing, Closed }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub timestamp: String,
    pub event: String,
    pub strategy: String,
    pub route: String,
    pub expected_profit_pct: f64,
    pub actual_profit_sol: Option<f64>,
    pub tx_hash: Option<String>,
    pub mode: String,
    pub execution_time_ms: Option<u64>,
    pub status: String,
    pub error: Option<String>,
}
