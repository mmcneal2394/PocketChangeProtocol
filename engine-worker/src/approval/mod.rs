pub mod telegram;
pub mod http_server;

use std::collections::HashMap;
use std::time::{Duration, Instant};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use rust_decimal::prelude::ToPrimitive;
use tracing::{info, warn};
use crate::types::*;
use crate::config::EngineConfig;

pub struct PendingOpportunity {
    pub opportunity: Opportunity,
    pub expires_at: Instant,
}

pub struct ApprovalRouter {
    config: Arc<EngineConfig>,
    pending: Arc<Mutex<HashMap<String, PendingOpportunity>>>,
    executor_tx: mpsc::Sender<Opportunity>,
    telegram: Option<Arc<telegram::TelegramBot>>,
}

impl ApprovalRouter {
    pub fn new(
        config: Arc<EngineConfig>,
        telegram: Option<Arc<telegram::TelegramBot>>,
        executor_tx: mpsc::Sender<Opportunity>,
    ) -> Self {
        Self {
            config,
            pending: Arc::new(Mutex::new(HashMap::new())),
            executor_tx,
            telegram,
        }
    }

    /// Main routing logic for incoming opportunities
    pub async fn route(&self, opp: Opportunity) {
        let threshold = self.config.get_strategy_threshold(&opp.strategy.to_string());
        let profit: f64 = opp.expected_profit_pct.to_f64().unwrap_or(0.0);

        // Paper mode: always log, never execute
        if self.config.mode == crate::config::EngineMode::Paper {
            info!("[PAPER] Opportunity detected: {} {} ({}%)", opp.strategy, opp.route, profit);
            if let Some(ref tg) = self.telegram {
                let _ = tg.send_opportunity(&opp).await;
            }
            return;
        }

        // Above threshold: auto-execute
        if profit >= threshold {
            info!("Auto-executing {} ({}% >= {}%)", opp.id, profit, threshold);
            let _ = self.executor_tx.send(opp).await;
            return;
        }

        // Below threshold: queue for approval
        info!("Queuing {} for approval ({}% < {}%)", opp.id, profit, threshold);
        let timeout = self.config.approval_timeout_secs;
        let pending_opp = PendingOpportunity {
            opportunity: opp.clone(),
            expires_at: Instant::now() + Duration::from_secs(timeout),
        };

        self.pending.lock().await.insert(opp.id.clone(), pending_opp);

        if let Some(ref tg) = self.telegram {
            let _ = tg.send_opportunity(&opp).await;
        }
    }

    /// Approve a pending opportunity (atomic -- only transitions once)
    pub async fn approve(&self, id: &str) -> anyhow::Result<()> {
        let opp = {
            let mut pending = self.pending.lock().await;
            pending.remove(id)
                .ok_or_else(|| anyhow::anyhow!("Opportunity {} not found or already resolved", id))?
        };
        info!("Approved opportunity {}", id);
        self.executor_tx.send(opp.opportunity).await
            .map_err(|_| anyhow::anyhow!("Executor channel closed"))?;
        Ok(())
    }

    /// Reject a pending opportunity
    pub async fn reject(&self, id: &str) -> anyhow::Result<()> {
        let mut pending = self.pending.lock().await;
        pending.remove(id)
            .ok_or_else(|| anyhow::anyhow!("Opportunity {} not found", id))?;
        info!("Rejected opportunity {}", id);
        Ok(())
    }

    /// Get list of pending opportunities (for HTTP API)
    pub async fn get_pending(&self) -> Vec<Opportunity> {
        let pending = self.pending.lock().await;
        pending.values().map(|p| p.opportunity.clone()).collect()
    }

    /// Clean up expired opportunities
    pub async fn expire_stale(&self) {
        let mut pending = self.pending.lock().await;
        let now = Instant::now();
        let expired: Vec<String> = pending.iter()
            .filter(|(_, p)| now > p.expires_at)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            pending.remove(id);
            warn!("Opportunity {} expired", id);
        }
    }

    /// Run expiry loop as background task
    pub async fn run_expiry_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            self.expire_stale().await;
        }
    }
}
