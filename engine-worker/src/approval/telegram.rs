use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};
use crate::types::Opportunity;

#[derive(Debug, Clone, PartialEq)]
pub enum TelegramCommand {
    Approve(String),
    Reject(String),
    Resume,
    Start,  // /start — registers the chat
}

pub struct TelegramBot {
    token: String,
    /// All chat IDs that have interacted with the bot — broadcasts to all of them
    subscribers: Arc<Mutex<HashSet<i64>>>,
    client: reqwest::Client,
}

impl TelegramBot {
    pub fn new(token: String) -> Self {
        Self {
            token,
            subscribers: Arc::new(Mutex::new(HashSet::new())),
            client: reqwest::Client::new(),
        }
    }

    pub fn from_env() -> Option<Self> {
        let token = std::env::var("TELEGRAM_BOT_TOKEN").ok()?;
        if token.is_empty() {
            return None;
        }
        let bot = Self::new(token);
        // Seed with TELEGRAM_CHAT_ID if provided (backward compat)
        if let Ok(chat_id) = std::env::var("TELEGRAM_CHAT_ID") {
            if let Ok(id) = chat_id.parse::<i64>() {
                let subs = bot.subscribers.clone();
                tokio::spawn(async move {
                    subs.lock().await.insert(id);
                });
            }
        }
        Some(bot)
    }

    /// Register a chat ID to receive broadcasts
    pub async fn subscribe(&self, chat_id: i64) {
        let mut subs = self.subscribers.lock().await;
        if subs.insert(chat_id) {
            info!("Telegram chat {} subscribed to alerts", chat_id);
        }
    }

    pub async fn send_opportunity(&self, opp: &Opportunity) -> anyhow::Result<()> {
        let text = format!(
            "🔍 *Arb Opportunity Detected*\n\
             Strategy: `{}`\n\
             Route: `{}`\n\
             Expected Profit: `{}%`\n\
             Trade Size: `{} USDC`\n\n\
             Reply: /approve\\_{} or /reject\\_{}",
            opp.strategy, opp.route, opp.expected_profit_pct,
            opp.trade_size_usdc, opp.id, opp.id
        );
        self.broadcast(&text).await
    }

    pub async fn send_alert(&self, message: &str) -> anyhow::Result<()> {
        self.broadcast(message).await
    }

    pub async fn send_trade_result(
        &self,
        opp_id: &str,
        success: bool,
        profit: Option<rust_decimal::Decimal>,
        tx_hash: Option<&str>,
    ) -> anyhow::Result<()> {
        let emoji = if success { "✅" } else { "❌" };
        let text = format!(
            "{} *Trade {}*\n\
             ID: `{}`\n\
             Profit: `{}`\n\
             TX: `{}`",
            emoji,
            if success { "Executed" } else { "Failed" },
            opp_id,
            profit.map(|p| format!("{} SOL", p)).unwrap_or("N/A".into()),
            tx_hash.unwrap_or("N/A"),
        );
        self.broadcast(&text).await
    }

    /// Send a message to ALL subscribed chats
    async fn broadcast(&self, text: &str) -> anyhow::Result<()> {
        let subs = self.subscribers.lock().await;
        if subs.is_empty() {
            warn!("No Telegram subscribers — message not sent. Add the bot to a channel and send /start");
            return Ok(());
        }
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        for chat_id in subs.iter() {
            let body = serde_json::json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "Markdown"
            });
            match self.client.post(&url).json(&body).send().await {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        warn!("Telegram send to {} failed: {}", chat_id, resp.status());
                    }
                }
                Err(e) => {
                    warn!("Telegram send to {} failed: {}", chat_id, e);
                }
            }
        }
        Ok(())
    }

    /// Poll for updates and auto-register any chat that messages the bot
    pub async fn poll_updates(&self, last_update_id: &mut i64) -> Vec<(i64, TelegramCommand)> {
        let url = format!(
            "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=1",
            self.token, *last_update_id + 1
        );
        let resp = match self.client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let body: serde_json::Value = match resp.json().await {
            Ok(b) => b,
            Err(_) => return vec![],
        };

        let mut commands = vec![];
        if let Some(results) = body["result"].as_array() {
            for update in results {
                if let Some(uid) = update["update_id"].as_i64() {
                    *last_update_id = uid;
                }

                // Auto-register any chat that sends a message
                if let Some(chat_id) = update["message"]["chat"]["id"].as_i64() {
                    self.subscribe(chat_id).await;

                    if let Some(text) = update["message"]["text"].as_str() {
                        if let Some(cmd) = Self::parse_command(text) {
                            if cmd == TelegramCommand::Start {
                                // Send welcome message to this specific chat
                                let welcome = "🚀 *PocketChange Engine Connected*\n\n\
                                    This chat will receive arbitrage alerts.\n\n\
                                    Commands:\n\
                                    /approve\\_<id> — approve an opportunity\n\
                                    /reject\\_<id> — reject an opportunity\n\
                                    /resume — resume after circuit breaker halt\n\
                                    /status — engine status";
                                let _ = self.send_to_chat(chat_id, welcome).await;
                            }
                            commands.push((chat_id, cmd));
                        }
                    }
                }
            }
        }
        commands
    }

    /// Send to a specific chat (for welcome messages, direct replies)
    async fn send_to_chat(&self, chat_id: i64, text: &str) -> anyhow::Result<()> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown"
        });
        self.client.post(&url).json(&body).send().await?;
        Ok(())
    }

    pub fn parse_command(text: &str) -> Option<TelegramCommand> {
        let text = text.trim();
        if text == "/start" {
            return Some(TelegramCommand::Start);
        }
        if text == "/resume" {
            return Some(TelegramCommand::Resume);
        }
        if let Some(id) = text.strip_prefix("/approve_") {
            return Some(TelegramCommand::Approve(id.to_string()));
        }
        if let Some(id) = text.strip_prefix("/reject_") {
            return Some(TelegramCommand::Reject(id.to_string()));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_approve_command() {
        assert_eq!(
            TelegramBot::parse_command("/approve_abc-123"),
            Some(TelegramCommand::Approve("abc-123".into()))
        );
    }

    #[test]
    fn test_parse_reject_command() {
        assert_eq!(
            TelegramBot::parse_command("/reject_xyz-456"),
            Some(TelegramCommand::Reject("xyz-456".into()))
        );
    }

    #[test]
    fn test_parse_resume_command() {
        assert_eq!(
            TelegramBot::parse_command("/resume"),
            Some(TelegramCommand::Resume)
        );
    }

    #[test]
    fn test_parse_start_command() {
        assert_eq!(
            TelegramBot::parse_command("/start"),
            Some(TelegramCommand::Start)
        );
    }

    #[test]
    fn test_parse_unknown_command() {
        assert_eq!(TelegramBot::parse_command("/unknown"), None);
        assert_eq!(TelegramBot::parse_command("hello"), None);
    }

    #[tokio::test]
    async fn test_subscribe_adds_chat_id() {
        let bot = TelegramBot::new("fake_token".into());
        bot.subscribe(12345).await;
        bot.subscribe(67890).await;
        bot.subscribe(12345).await; // duplicate
        let subs = bot.subscribers.lock().await;
        assert_eq!(subs.len(), 2);
        assert!(subs.contains(&12345));
        assert!(subs.contains(&67890));
    }
}
