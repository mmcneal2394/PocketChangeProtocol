import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
// import { TwitterApi } from 'twitter-api-v2';

// We dynamically import openai to avoid hard failure if not installed globally
let OpenAI: any;
try {
  OpenAI = require('openai');
} catch (e) {
  console.log("⚠️ OpenAI dependency missing. Please `npm install openai` before running live generation.");
}

const configPath = path.join(__dirname, '..', 'src', 'config.yaml');

async function main() {
  console.log("🤖 --- PocketChange Automated Twitter Manager ---");

  // 1. Read the global config
  let config: any = {};
  try {
    const file = fs.readFileSync(configPath, 'utf8');
    config = yaml.parse(file);
  } catch (err) {
    console.error("Failed to read config.yaml. Exiting.", err);
    return;
  }

  const isSimulated = config?.data_sources?.price_feed?.mode === 'simulated';
  console.log(`📡 Operational Mode: ${isSimulated ? 'SIMULATED' : 'LIVE TETHERED'}\n`);

  // 2. Fetch or Mock the statistics for the Prompt
  let stats = { tvl: "$1.42M", apy: "142.4%", trades: 120, recentProfit: "$4,500" };
  if (isSimulated) {
    stats = { tvl: "$2.50M", apy: "45.2%", trades: 450, recentProfit: "$1,200" };
  }

  const PCP_CONTRACT_ADDRESS = "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";

  const prompt = `
You are the hype-manager and community lead for PocketChange ($PCP), a high-frequency decentralized arbitrage engine on Solana.
Write a highly engaging, viral, short tweet (under 240 characters) announcing our current stats.
Use emojis. Be bullish. Sound native to CT (Crypto Twitter).
Must include the token contract address: ${PCP_CONTRACT_ADDRESS}
Stats:
- TVL: ${stats.tvl}
- Current Staking APY: ${stats.apy}
- Arbitrage Trades Today: ${stats.trades}
- Last 24h Profit Distributed: ${stats.recentProfit}

Remember to include the disclaimer "Not financial advice" somewhere brief, or just #NFA.
`;

  // 3. Generate Tweet text (If API key exists)
  let generatedTweet = `🚀 PocketChange Arbitrage Engine absolute printing! \n\nTVL: ${stats.tvl} 🔥\nCurrent APY: ${stats.apy} 🤑\nTrades today: ${stats.trades} pulling in ${stats.recentProfit} for stakers.\n\nCA: ${PCP_CONTRACT_ADDRESS}\n\nThe compounding never stops. Stake your $PCP today! #Solana #DeFi #NFA 💸💎`;
  
  if (OpenAI && process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log("🧠 Querying OpenAI for viral tweet generation...");
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }]
      });
      generatedTweet = response.choices[0].message?.content || generatedTweet;
    } catch (err: any) {
        console.error("OpenAI generation failed (fallback to default): ", err.message);
    }
  }

  console.log("\n================ TWEET PREVIEW ================");
  console.log(generatedTweet);
  console.log("===============================================\n");

  // 4. Execution Mode Handling
  if (isSimulated) {
    console.log("🛑 Configuration is set to SIMULATED. Tweet was logged to console and NOT published to X.");
  } else {
    console.log("🌐 Configuration is set to LIVE. Attempting to broadcast to X App...");
    // Live posting implementation goes here...
    // const client = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
    // await client.v2.tweet(generatedTweet);
    console.log("✅ (Mocked) Broadcast Successful.");
  }
}

main().catch(console.error);
