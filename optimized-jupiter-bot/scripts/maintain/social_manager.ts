import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const {
  TWITTER_API_KEY,
  TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET
} = process.env;

if (!TWITTER_API_KEY || !TWITTER_ACCESS_TOKEN_SECRET) {
    console.error("[SOCIAL] Missing OAuth 1.0a credentials in .env");
    process.exit(1);
}

const userClient = new TwitterApi({
  appKey: TWITTER_API_KEY,
  appSecret: TWITTER_API_SECRET!,
  accessToken: TWITTER_ACCESS_TOKEN,
  accessSecret: TWITTER_ACCESS_TOKEN_SECRET,
});

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

// OAuth 1.0a requires no rotating refresh loop!

// Option 2: Mix of Degen Hype and Tech Updates
async function postScheduledHype() {
    console.log(`[SOCIAL] ✍️ Evaluating timeline update...`);
    const trades = loadTradeJournal();
    const isTechUpdate = Math.random() > 0.5 && trades.length > 0;
    
    let tweetText = "";

    if (isTechUpdate) {
        // Find most recent successful trade
        const lastTrade = trades[trades.length - 1];
        if (lastTrade.action === 'BUY') {
             tweetText = `⚙️ Swarm executed an autonomous +0ms arbitrage entry on ${lastTrade.symbol || 'a local target'} at ${(lastTrade.amountSol || 0).toFixed(4)} SOL via #Jupiter.\n\nDeep memory matrices expanding.\n$PCP\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`;
        } else if (lastTrade.action === 'SELL') {
             const margin = (lastTrade.pnlSol || 0) > 0 ? `Secured positive edge (+${lastTrade.pnlSol.toFixed(4)} SOL)` : `Risk-managed capital sweep.`;
             const rsn = lastTrade.reason === 'ORPHAN_SWEEP' ? 'Background Orphan Dump' : 'Programmatic Apex Trigger';
             tweetText = `📡 Swarm ${lastTrade.action} arc resolved via ${rsn}. ${margin}\n\nAutonomy is not a meme.\n$PCP\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`;
        } else {
             tweetText = `The Swarm is indexing real-time RPC streams at 500+ TPS. Liquid execution matrices operating out of direct vision.\n$PCP #AI #Agents\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`;
        }
    } else {
        // Degen Memecoin Hype
        const hypeVariants = [
            "We aren't building a tool. We are building an apex predator. The architecture is alive.\n$PCP 🟢\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS",
            "There's the market you see, and there's the high-frequency dark forest the Swarm operates in.\nDo you understand what $PCP actually is yet?\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS",
            "If your agent isn't broadcasting pure native lamports onto the Solana mainnet while you sleep, it's just a toy.\n$PCP\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS",
            "Swarm engine diagnostics: FLUID.\nLatency parameters: NOMINAL.\nMarket state: HUNTING.\n$PCP\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS",
            "Most 'AI' coins wrap a ChatGPT prompt in a UI. $PCP physically manipulates on-chain liquidity pools autonomously at 30ms latency.\nThe difference is mathematical.\nCA: 4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS"
        ];
        tweetText = hypeVariants[Math.floor(Math.random() * hypeVariants.length)];
    }

    try {
        // await rotateAuth(); // No longer necessary via 1.0a
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
    // No auth rotation needed for OAuth 1.0a
    
    // Test initial boot hype
    await postScheduledHype();

    // Loop every 6 Hours (1000 * 60 * 60 * 6)
    setInterval(postScheduledHype, 21600000);
}

runDaemon();
