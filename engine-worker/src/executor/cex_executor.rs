use rust_decimal::Decimal;
use serde::Serialize;
use std::time::Instant;
// tracing used by consuming modules

#[derive(Debug, Clone, Serialize)]
pub enum CexDexStatus {
    DexPending,
    DexConfirmed,
    CexPending,
    CexConfirmed,
    Stuck,
    Unwinding,
    Settled,
}

#[derive(Debug, Clone, Serialize)]
pub struct CexDexPosition {
    pub id: String,
    pub status: CexDexStatus,
    pub dex_tx_hash: Option<String>,
    pub cex_order_id: Option<String>,
    pub pair: String,
    pub size: Decimal,
    #[serde(skip)]
    pub opened_at: Instant,
    pub max_exposure_secs: u64,
}

impl CexDexPosition {
    pub fn is_expired(&self) -> bool {
        self.opened_at.elapsed().as_secs() > self.max_exposure_secs
    }
}
