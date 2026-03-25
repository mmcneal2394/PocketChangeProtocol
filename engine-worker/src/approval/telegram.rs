use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};
use crate::types::Opportunity;

#[derive(Debug, Clone, PartialEq)]
pub enum TelegramCommand {
    Start,
    Stop,
    Status,
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

    /// Poll for updates — handles messages, commands, AND bot added/removed from groups
    pub async fn poll_updates(&self, last_update_id: &mut i64) -> Vec<(i64, TelegramCommand)> {
        let url = format!(
            "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=1&allowed_updates=[\"message\",\"my_chat_member\"]",
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

                // Handle bot added/removed from groups (auto-start like pump-claims)
                if let Some(member_update) = update.get("my_chat_member") {
                    let chat_id = member_update["chat"]["id"].as_i64().unwrap_or(0);
                    let new_status = member_update["new_chat_member"]["status"].as_str().unwrap_or("");

                    if new_status == "member" || new_status == "administrator" {
                        // Bot was added to a group — auto-subscribe and welcome
                        self.subscribe(chat_id).await;
                        let _ = self.send_welcome(chat_id).await;
                        info!("Bot added to chat {}, auto-subscribed", chat_id);
                    } else if new_status == "left" || new_status == "kicked" {
                        // Bot was removed — unsubscribe
                        self.subscribers.lock().await.remove(&chat_id);
                        info!("Bot removed from chat {}, unsubscribed", chat_id);
                    }
                    continue;
                }

                // Handle regular messages with commands
                if let Some(chat_id) = update["message"]["chat"]["id"].as_i64() {
                    if let Some(text) = update["message"]["text"].as_str() {
                        if let Some(cmd) = Self::parse_command(text) {
                            match &cmd {
                                TelegramCommand::Start => {
                                    self.subscribe(chat_id).await;
                                    let _ = self.send_welcome(chat_id).await;
                                }
                                TelegramCommand::Stop => {
                                    self.subscribers.lock().await.remove(&chat_id);
                                    let _ = self.send_to_chat(chat_id, "Notifications paused. Send /start to resume.").await;
                                    info!("Chat {} unsubscribed via /stop", chat_id);
                                }
                                _ => {}
                            }
                            commands.push((chat_id, cmd));
                        }
                    }
                }
            }
        }
        commands
    }

    /// Send welcome message (used on /start and when bot is added to group)
    async fn send_welcome(&self, chat_id: i64) -> anyhow::Result<()> {
        let welcome = "<b>PocketChange Arbitrage Engine</b>\n\n\
            This chat will receive real-time arbitrage alerts.\n\n\
            <b>Commands:</b>\n\
            /approve_&lt;id&gt; — execute an opportunity\n\
            /reject_&lt;id&gt; — skip an opportunity\n\
            /resume — resume after circuit breaker halt\n\
            /status — engine health check\n\
            /stop — pause notifications";
        self.send_to_chat_html(chat_id, welcome).await
    }

    /// Send to a specific chat with HTML parse mode
    async fn send_to_chat_html(&self, chat_id: i64, text: &str) -> anyhow::Result<()> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML"
        });
        self.client.post(&url).json(&body).send().await?;
        Ok(())
    }

    /// Send to a specific chat (Markdown)
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
        // Strip @botname suffix (e.g., /start@PCP_notibot)
        let text = text.split('@').next().unwrap_or(text);
        match text {
            "/start" => Some(TelegramCommand::Start),
            "/stop" => Some(TelegramCommand::Stop),
            "/status" => Some(TelegramCommand::Status),
            _ => None,
        }
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
