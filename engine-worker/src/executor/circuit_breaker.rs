use rust_decimal::Decimal;
use std::time::{Duration, Instant};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CircuitBreaker {
    max_loss_24h: Decimal,
    max_single_trade: Decimal,
    #[serde(skip)]
    trades_24h: Vec<(Instant, Decimal)>,
    consecutive_failures: u32,
    tripped: bool,
    trip_reason: Option<String>,
    #[serde(skip)]
    pause_until: Option<Instant>,
}

impl CircuitBreaker {
    pub fn new(max_loss_24h: Decimal, max_single_trade: Decimal) -> Self {
        Self {
            max_loss_24h,
            max_single_trade,
            trades_24h: Vec::new(),
            consecutive_failures: 0,
            tripped: false,
            trip_reason: None,
            pause_until: None,
        }
    }

    pub fn record_trade(&mut self, profit_sol: Decimal) {
        self.trades_24h.push((Instant::now(), profit_sol));
        self.cleanup_old_trades();

        // Check single trade loss
        if profit_sol < Decimal::ZERO && profit_sol.abs() > self.max_single_trade {
            self.trip(format!(
                "Single trade loss {} SOL exceeds limit {} SOL",
                profit_sol, self.max_single_trade
            ));
            return;
        }

        // Check cumulative 24h loss
        let total: Decimal = self.trades_24h.iter().map(|(_, p)| p).sum();
        if total < Decimal::ZERO && total.abs() > self.max_loss_24h {
            self.trip(format!(
                "24h cumulative loss {} SOL exceeds limit {} SOL",
                total, self.max_loss_24h
            ));
        }
    }

    pub fn record_failure(&mut self) {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= 5 {
            self.trip("5 consecutive failed transactions".to_string());
            self.pause_until = Some(Instant::now() + Duration::from_secs(300));
        }
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        // Check if pause has expired
        if let Some(until) = self.pause_until {
            if Instant::now() > until {
                self.pause_until = None;
                if self.trip_reason.as_deref() == Some("5 consecutive failed transactions") {
                    self.resume();
                }
            }
        }
    }

    pub fn is_tripped(&self) -> bool {
        if let Some(until) = self.pause_until {
            if Instant::now() > until {
                return false;
            }
        }
        self.tripped
    }

    pub fn trip_reason(&self) -> Option<&str> {
        self.trip_reason.as_deref()
    }

    pub fn resume(&mut self) {
        self.tripped = false;
        self.trip_reason = None;
        self.consecutive_failures = 0;
        self.pause_until = None;
    }

    fn trip(&mut self, reason: String) {
        self.tripped = true;
        self.trip_reason = Some(reason);
    }

    fn cleanup_old_trades(&mut self) {
        if let Some(cutoff) = Instant::now().checked_sub(Duration::from_secs(86400)) {
            self.trades_24h.retain(|(t, _)| *t > cutoff);
        }
        // If checked_sub returns None (system uptime < 24h), all trades are recent — keep all
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_breaker_24h_loss_limit() {
        let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(30, 0));
        cb.record_trade(Decimal::new(-28, 0));
        assert!(!cb.is_tripped());
        cb.record_trade(Decimal::new(-25, 0));
        assert!(cb.is_tripped());
        assert!(cb.trip_reason().unwrap().contains("24h cumulative loss"));
    }

    #[test]
    fn test_circuit_breaker_single_trade_limit() {
        let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
        cb.record_trade(Decimal::new(-25, 0));
        assert!(cb.is_tripped());
        assert!(cb.trip_reason().unwrap().contains("Single trade loss"));
    }

    #[test]
    fn test_circuit_breaker_consecutive_failures() {
        let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
        for _ in 0..4 {
            cb.record_failure();
        }
        assert!(!cb.is_tripped());
        cb.record_failure(); // 5th
        assert!(cb.is_tripped());
    }

    #[test]
    fn test_circuit_breaker_manual_resume() {
        let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
        for _ in 0..5 { cb.record_failure(); }
        assert!(cb.is_tripped());
        cb.resume();
        assert!(!cb.is_tripped());
        assert_eq!(cb.consecutive_failures, 0);
    }

    #[test]
    fn test_profitable_trades_dont_trip() {
        let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
        cb.record_trade(Decimal::new(100, 0));
        cb.record_trade(Decimal::new(200, 0));
        assert!(!cb.is_tripped());
    }
}
