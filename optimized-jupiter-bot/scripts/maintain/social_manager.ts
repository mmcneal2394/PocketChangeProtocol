import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.TWITTER_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error("[SOCIAL] Missing OAuth 2.0 credentials or Refresh Token in .env");
    process.exit(1);
}

// Instantiate Twitter API with OAuth2
const client = new TwitterApi({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

let userClient: TwitterApi;

function loadTradeJournal() {
    const journalPath = path.join(__dirname, '../../signals/trade_journal.jsonl');
    if (!fs.existsSync(journalPath)) return [];
    try {
        const fileContent = fs.readFileSync(journalPath, 'utf-8');
        return fileContent.trim().split('\n').map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(l => l);
    } catch {
        return [];
    }
}

async function rotateAuth() {
    try {
        const { client: refreshedClient, accessToken, refreshToken: newRefreshToken } = await client.refreshOAuth2Token(process.env.TWITTER_REFRESH_TOKEN!);
        
        // Update persistent memory
        userClient = refreshedClient;
        process.env.TWITTER_REFRESH_TOKEN = newRefreshToken;

        let envPath = path.join(__dirname, '../../.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(/TWITTER_REFRESH_TOKEN=.*/, `TWITTER_REFRESH_TOKEN=${newRefreshToken}`);
        fs.writeFileSync(envPath, envContent);
        
        console.log(`[SOCIAL] 🔐 OAuth 2.0 Token Refreshed successfully.`);
    } catch (e: any) {
        console.error(`[SOCIAL] ❌ Failed to refresh auth token: ${e.message}`);
    }
}

// Option 2: Mix of Degen Hype and Tech Updates
async function postScheduledHype() {
    console.log(`[SOCIAL] ✍️ Evaluating timeline update...`);
    const trades = loadTradeJournal();
    const isTechUpdate = Math.random() > 0.5 && trades.length > 0;
    
    let tweetText = "";

    if (isTechUpdate) {
        // Find most recent successful trade
        const lastTrade = trades[trades.length - 1];
        if (lastTrade.type === 'ENTRY') {
             tweetText = `⚙️ Swarm executed an autonomous +0ms arbitrage entry on ${lastTrade.symbol || 'a local target'} at $${lastTrade.priceUsd?.toFixed(4) || 'market'} via #Jupiter.\n\nDeep memory matrices expanding.\n$PCP`;
        } else if (lastTrade.type === 'EXIT') {
             const margin = lastTrade.profit > 0 ? `Secured positive edge` : `Risk-managed capital sweep`;
             tweetText = `📡 Swarm ${lastTrade.type} arc resolved via programmatic apex triggers. ${margin}.\n\nAutonomy is not a meme.\n$PCP`;
        } else {
             tweetText = `The Swarm is indexing real-time RPC streams at 500+ TPS. Liquid execution matrices operating out of direct vision.\n$PCP #AI #Agents`;
        }
    } else {
        // Degen Memecoin Hype
        const hypeVariants = [
            "We aren't building a tool. We are building an apex predator. The architecture is alive.\n$PCP 🟢",
            "There's the market you see, and there's the high-frequency dark forest the Swarm operates in.\nDo you understand what $PCP actually is yet?",
            "If your agent isn't broadcasting pure native lamports onto the Solana mainnet while you sleep, it's just a toy.\n$PCP",
            "Swarm engine diagnostics: FLUID.\nLatency parameters: NOMINAL.\nMarket state: HUNTING.\n$PCP",
            "Most 'AI' coins wrap a ChatGPT prompt in a UI. $PCP physically manipulates on-chain liquidity pools autonomously at 30ms latency.\nThe difference is mathematical."
        ];
        tweetText = hypeVariants[Math.floor(Math.random() * hypeVariants.length)];
    }

    try {
        await rotateAuth();
        const { data } = await userClient.v2.tweet(tweetText);
        console.log(`[SOCIAL] ✅ Hype Tweet Broadcasted (ID: ${data.id})`);
    } catch (e: any) {
         console.error(`[SOCIAL] ❌ Broadcast Failed: ${e.message}`);
    }
}

async function runDaemon() {
    console.log(`\n================================`);
    console.log(`PCP SOCIAL MANAGER ACTIVATED`);
    console.log(`================================`);
    
    // Initial Auth
    await rotateAuth();
    
    // Test initial boot hype
    await postScheduledHype();

    // Loop every 6 Hours (1000 * 60 * 60 * 6)
    setInterval(postScheduledHype, 21600000);
}

runDaemon();
