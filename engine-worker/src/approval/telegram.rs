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
    subscribers: Arc<Mutex<HashSet<i64>>>,
    client: reqwest::Client,
    api_base: String,
}

impl TelegramBot {
    pub fn new(token: String) -> Self {
        let api_base = std::env::var("NEXTJS_API_URL")
            .unwrap_or_else(|_| "http://localhost:3000".to_string());
        Self {
            token,
            subscribers: Arc::new(Mutex::new(HashSet::new())),
            client: reqwest::Client::new(),
            api_base,
        }
    }

    pub fn from_env() -> Option<Self> {
        let token = std::env::var("TELEGRAM_BOT_TOKEN").ok()?;
        if token.is_empty() {
            return None;
        }
        let bot = Self::new(token);
        // Seed from TELEGRAM_CHAT_ID env var so subscribers survive redeploys
        if let Ok(chat_id) = std::env::var("TELEGRAM_CHAT_ID") {
            if let Ok(id) = chat_id.parse::<i64>() {
                let subs = bot.subscribers.clone();
                tokio::spawn(async move {
                    subs.lock().await.insert(id);
                    info!("Seeded subscriber from TELEGRAM_CHAT_ID: {}", id);
                });
            }
        }
        Some(bot)
    }

    /// Load subscribers from the API on startup
    pub async fn load_subscribers(&self) {
        let url = format!("{}/api/telegram-chats", self.api_base);
        match self.client.get(&url).send().await {
            Ok(resp) => {
                if let Ok(chats) = resp.json::<Vec<serde_json::Value>>().await {
                    let mut subs = self.subscribers.lock().await;
                    for chat in chats {
                        if let Some(chat_id) = chat["chatId"].as_i64() {
                            subs.insert(chat_id);
                        }
                    }
                    info!("Loaded {} Telegram subscribers from DB", subs.len());
                }
            }
            Err(e) => {
                warn!("Failed to load Telegram subscribers: {} — will discover via /start", e);
            }
        }
    }

    /// Register a chat and persist to DB
    pub async fn subscribe(&self, chat_id: i64, chat_type: &str, title: Option<&str>) {
        let mut subs = self.subscribers.lock().await;
        if subs.insert(chat_id) {
            info!("Telegram chat {} subscribed to alerts", chat_id);
        }
        drop(subs);

        // Persist to DB via API
        let url = format!("{}/api/telegram-chats", self.api_base);
        let body = serde_json::json!({
            "chatId": chat_id,
            "chatType": chat_type,
            "title": title,
        });
        if let Err(e) = self.client.post(&url).json(&body).send().await {
            warn!("Failed to persist chat {} to DB: {}", chat_id, e);
        }
    }

    /// Unsubscribe and deactivate in DB
    pub async fn unsubscribe(&self, chat_id: i64) {
        self.subscribers.lock().await.remove(&chat_id);
        info!("Chat {} unsubscribed", chat_id);

        let url = format!("{}/api/telegram-chats", self.api_base);
        let body = serde_json::json!({ "chatId": chat_id, "isActive": false });
        let _ = self.client.patch(&url).json(&body).send().await;
    }

    pub async fn send_opportunity(&self, opp: &Opportunity) -> anyhow::Result<()> {
        let gross_profit = opp.expected_profit_pct + opp.estimated_fees_pct;
        let text = format!(
            "<b>Arb Opportunity Detected</b>\n\n\
             Strategy: <code>{}</code>\n\
             Route: <code>{}</code>\n\
             Expected Profit (net): <code>{}%</code>\n\
             Trade Size: <code>{} USDC</code>\n\
             Est. Fees: <code>{}%</code>\n\
             Gross Profit: <code>{}%</code>",
            opp.strategy, opp.route, opp.expected_profit_pct,
            opp.trade_size_usdc, opp.estimated_fees_pct, gross_profit
        );
        self.broadcast_html(&text).await
    }

    pub async fn send_alert(&self, message: &str) -> anyhow::Result<()> {
        self.broadcast_html(message).await
    }

    async fn broadcast_html(&self, text: &str) -> anyhow::Result<()> {
        let subs = self.subscribers.lock().await;
        if subs.is_empty() {
            warn!("No Telegram subscribers — add bot to a group");
            return Ok(());
        }
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        for chat_id in subs.iter() {
            let body = serde_json::json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML"
            });
            match self.client.post(&url).json(&body).send().await {
                Ok(resp) if !resp.status().is_success() => {
                    warn!("Telegram send to {} failed: {}", chat_id, resp.status());
                }
                Err(e) => warn!("Telegram send to {} failed: {}", chat_id, e),
                _ => {}
            }
        }
        Ok(())
    }

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

                // Bot added/removed from group
                if let Some(member_update) = update.get("my_chat_member") {
                    let chat_id = member_update["chat"]["id"].as_i64().unwrap_or(0);
                    let chat_type = member_update["chat"]["type"].as_str().unwrap_or("group");
                    let title = member_update["chat"]["title"].as_str();
                    let new_status = member_update["new_chat_member"]["status"].as_str().unwrap_or("");

                    if new_status == "member" || new_status == "administrator" {
                        self.subscribe(chat_id, chat_type, title).await;
                        let _ = self.send_welcome(chat_id).await;
                        info!("Bot added to chat {}, auto-subscribed", chat_id);
                    } else if new_status == "left" || new_status == "kicked" {
                        self.unsubscribe(chat_id).await;
                    }
                    continue;
                }

                // Regular message commands
                if let Some(chat_id) = update["message"]["chat"]["id"].as_i64() {
                    let chat_type = update["message"]["chat"]["type"].as_str().unwrap_or("private");
                    let title = update["message"]["chat"]["title"].as_str();

                    if let Some(text) = update["message"]["text"].as_str() {
                        if let Some(cmd) = Self::parse_command(text) {
                            match &cmd {
                                TelegramCommand::Start => {
                                    self.subscribe(chat_id, chat_type, title).await;
                                    let _ = self.send_welcome(chat_id).await;
                                }
                                TelegramCommand::Stop => {
                                    self.unsubscribe(chat_id).await;
                                    let _ = self.send_to_chat(chat_id, "Notifications paused. Send /start to resume.").await;
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

    async fn send_welcome(&self, chat_id: i64) -> anyhow::Result<()> {
        let welcome = "<b>PocketChange Arbitrage Engine</b>\n\n\
            This chat will receive real-time arbitrage alerts.\n\n\
            <b>Commands:</b>\n\
            /status — engine health check\n\
            /stop — pause notifications\n\
            /start — resume notifications";
        self.send_to_chat_html(chat_id, welcome).await
    }

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

    async fn send_to_chat(&self, chat_id: i64, text: &str) -> anyhow::Result<()> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text
        });
        self.client.post(&url).json(&body).send().await?;
        Ok(())
    }

    pub async fn subscriber_count(&self) -> usize {
        self.subscribers.lock().await.len()
    }

    pub fn parse_command(text: &str) -> Option<TelegramCommand> {
        let text = text.trim();
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
    fn test_parse_start() {
        assert_eq!(TelegramBot::parse_command("/start"), Some(TelegramCommand::Start));
    }

    #[test]
    fn test_parse_stop() {
        assert_eq!(TelegramBot::parse_command("/stop"), Some(TelegramCommand::Stop));
    }

    #[test]
    fn test_parse_status() {
        assert_eq!(TelegramBot::parse_command("/status"), Some(TelegramCommand::Status));
    }

    #[test]
    fn test_parse_with_botname() {
        assert_eq!(TelegramBot::parse_command("/start@PCP_notibot"), Some(TelegramCommand::Start));
    }

    #[test]
    fn test_parse_unknown() {
        assert_eq!(TelegramBot::parse_command("/unknown"), None);
        assert_eq!(TelegramBot::parse_command("hello"), None);
    }

    #[tokio::test]
    async fn test_subscribe_adds_chat_id() {
        let bot = TelegramBot::new("fake_token".into());
        bot.subscribe(12345, "group", Some("Test Group")).await;
        bot.subscribe(67890, "private", None).await;
        bot.subscribe(12345, "group", Some("Test Group")).await; // duplicate
        let subs = bot.subscribers.lock().await;
        assert_eq!(subs.len(), 2);
        assert!(subs.contains(&12345));
        assert!(subs.contains(&67890));
    }
}
