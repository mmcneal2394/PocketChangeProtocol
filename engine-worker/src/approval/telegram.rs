use tracing::{info, warn, error};
use crate::types::Opportunity;

#[derive(Debug, Clone, PartialEq)]
pub enum TelegramCommand {
    Approve(String),  // opportunity ID
    Reject(String),
    Resume,
}

pub struct TelegramBot {
    token: String,
    chat_id: String,
    client: reqwest::Client,
}

impl TelegramBot {
    pub fn new(token: String, chat_id: String) -> Self {
        Self { token, chat_id, client: reqwest::Client::new() }
    }

    pub fn from_env() -> Option<Self> {
        let token = std::env::var("TELEGRAM_BOT_TOKEN").ok()?;
        let chat_id = std::env::var("TELEGRAM_CHAT_ID").ok()?;
        Some(Self::new(token, chat_id))
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
        self.send_message(&text).await
    }

    pub async fn send_alert(&self, message: &str) -> anyhow::Result<()> {
        self.send_message(message).await
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
        self.send_message(&text).await
    }

    async fn send_message(&self, text: &str) -> anyhow::Result<()> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let body = serde_json::json!({
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "Markdown"
        });
        match self.client.post(&url).json(&body).send().await {
            Ok(_) => Ok(()),
            Err(e) => {
                warn!("Telegram send failed: {}", e);
                Ok(()) // Non-critical, don't propagate
            }
        }
    }

    pub async fn poll_updates(&self, last_update_id: &mut i64) -> Vec<TelegramCommand> {
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
                if let Some(text) = update["message"]["text"].as_str() {
                    if let Some(cmd) = Self::parse_command(text) {
                        commands.push(cmd);
                    }
                }
            }
        }
        commands
    }

    pub fn parse_command(text: &str) -> Option<TelegramCommand> {
        let text = text.trim();
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
    fn test_parse_unknown_command() {
        assert_eq!(TelegramBot::parse_command("/unknown"), None);
        assert_eq!(TelegramBot::parse_command("hello"), None);
    }
}
