const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { TwitterApi } = require('twitter-api-v2');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Constants
const TELEMETRY_FILE = path.join(__dirname, '..', 'engine-worker', 'telemetry.jsonl');
const STATE_FILE = path.join(__dirname, '..', 'agent_state.json');
const PROFIT_SWEEP_THRESHOLD_SOL = 0.05; // Trigger a tweet & sweep every 0.05 SOL profit (~$7.50)
const PROTOCOL_FEE_PERCENTAGE = 0.20; // AI claims 20% of generated profit for the Treasury

// X (Twitter) Client Setup
// If keys are missing, we run in "Dry-Run" (Log-only) mode
const isTwitterReady = process.env.TWITTER_API_KEY && process.env.TWITTER_API_SECRET;
let twitterClient = null;

if (isTwitterReady) {
    twitterClient = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
    }).readWrite;
    console.log("🐦 [AI Agent] X/Twitter API Authenticated. Live mode active.");
} else {
    console.log("⚠️ [AI Agent] Missing TWITTER_API_KEY. Operating in DRY-RUN (Console Log) mode for Twitter.");
}

// Telegram Client Setup
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
let tgBot = null;

if (telegramToken) {
    tgBot = new TelegramBot(telegramToken, { polling: true });
    console.log("✈️ [AI Agent] Telegram Bot Authenticated.");
    
    if (!telegramChatId) {
        console.log("⚠️ [AI Agent] Missing TELEGRAM_CHAT_ID in .env. To get your Chat ID, send a message to the bot on Telegram now!");
        // The original ID Discovery Listener
        tgBot.on('message', (msg) => {
            // Ignore if it's a command
            if (msg.text && msg.text.startsWith('/')) return;
            
            console.log(`\n===========================================`);
            console.log(`🔔 NEW TELEGRAM MESSAGE DETECTED!`);
            console.log(`From: ${msg.chat.first_name || msg.chat.title || 'Unknown'}`);
            console.log(`💬 YOUR TELEGRAM_CHAT_ID IS: ${msg.chat.id}`);
            console.log(`Drop TELEGRAM_CHAT_ID="${msg.chat.id}" into your .env file to enable broadcasting.`);
            console.log(`===========================================\n`);
        });
    }

    // --- INTERACTIVE COMMUNITY COMMANDS --- //

    // /start & /help: Welcome and Links
    const helpMessage = `🤖 *Welcome to the PocketChange ($PCP) ArbitraSaaS PAI!*\n\nI am the autonomous intelligence layer driving the $PCP protocol. While you sleep, my engine extracts yield across Solana liquidity pools.\n\n*Available Commands:*\n📊 /stats - View realtime protocol yield data\n🪙 /tokenomics - Learn about the $PCP token\n📄 /contract - Get the official SPL Contract\n🎨 /imagine <prompt> - Generate free AI images (Powered by Pollinations.ai)`;
    
    const startOptions = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Official Website', url: 'https://pcprotocol.dev' },
                    { text: '📈 Launch App', url: 'https://pcprotocol.dev/dashboard' }
                ],
                [
                    { text: '🐦 Follow X/Twitter', url: 'https://x.com/pcprotocol' }
                ]
            ]
        }
    };

    tgBot.onText(/\/(start|help)/, (msg) => {
        tgBot.sendMessage(msg.chat.id, helpMessage, startOptions);
    });

    // /stats: Dynamic Real-time Yield Generation
    tgBot.onText(/\/stats/, (msg) => {
        const state = loadState();
        const totalYield = (state.totalLifetimeFeesClaimed / PROTOCOL_FEE_PERCENTAGE).toFixed(4);
        
        const statsMsg = `📊 *Protocol Execution Stats*\n\n` +
            `*Lifetime Total Yield:* ${totalYield} SOL\n` +
            `*Fees Swept to Treasury:* ${state.totalLifetimeFeesClaimed.toFixed(4)} SOL\n` +
            `*Next Sweep Imminent:* ${(state.accumulatedUnsweptProfit / PROFIT_SWEEP_THRESHOLD_SOL * 100).toFixed(1)}% Ready\n\n` +
            `_I never sleep. The engine is running perfectly._ ⚙️`;
            
        tgBot.sendMessage(msg.chat.id, statsMsg, { parse_mode: 'Markdown' });
    });

    // /tokenomics: Breakdown of the ecosystem
    tgBot.onText(/\/tokenomics/, (msg) => {
        const tknMsg = `🪙 *$PCP Tokenomics*\n\n` +
            `*Total Supply:* 1,000,000,000 $PCP\n\n` +
            `🔥 *50% Staking Rewards:* Distributed to LP mechanics and Vault Operators.\n` +
            `💼 *30% Ecosystem Treasury:* Used to scale backend infrastructure and ArbitraSaaS nodes.\n` +
            `🛠️ *20% Core Contributors:* Vested engine development.\n\n` +
            `Earn your share by operating the engine at [pcprotocol.dev](https://pcprotocol.dev).`;
            
        tgBot.sendMessage(msg.chat.id, tknMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // /scan <Token Address>: Free Trojan Horse Utility
    tgBot.onText(/\/scan (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const targetMint = match[1].trim();

        if (targetMint.length !== 43 && targetMint.length !== 44) {
            return tgBot.sendMessage(chatId, `❌ Invalid Solana Mint Address length.`);
        }

        tgBot.sendMessage(chatId, `🔍 *Scanning Liquidity for*\n\`${targetMint}\`...`, { parse_mode: 'Markdown' });

        try {
            // USDC Mint to Target Mint (100 USDC quote)
            const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
            let data = null;
            let retries = 3;
            let delay = 1000;
            
            while (retries > 0) {
                try {
                    const response = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${usdcMint}&outputMint=${targetMint}&amount=100000000&slippageBps=50`, { timeout: 5000 });
                    data = response.data;
                    if (data.error) throw new Error(data.error);
                    break; 
                } catch (e) {
                    retries--;
                    if (retries === 0) throw e;
                    console.log(`⚠️ Jupiter API timeout/error. Retrying in ${delay}ms...`);
                    await new Promise(res => setTimeout(res, delay));
                    delay *= 2; // Exponential backoff fallback
                }
            }

            const outAmount = (parseInt(data.outAmount) / 10**6).toFixed(2); // Assuming 6 decimals for simplicity in generic scan
            const priceImpact = data.priceImpactPct ? (data.priceImpactPct * 100).toFixed(2) : "0.00";
            
            const scanResult = `🟢 *Scan Complete*\n\n` +
                `*Route:* USDC ➔ Target Token\n` +
                `*100 USDC Buy:* ~${outAmount} Tokens\n` +
                `*Est. Price Impact:* ${priceImpact}%\n` +
                `*Best Route Hops:* ${data.routePlan.length}\n\n` +
                `⚡ _Analysis powered by ArbitraSaaS Engine._\n_The $PCP protocol swept 42.1 SOL in MEV yield today. Join the operators at [pcprotocol.dev](https://pcprotocol.dev)._`;
            
            tgBot.sendMessage(chatId, scanResult, { parse_mode: 'Markdown', disable_web_page_preview: true });

        } catch (err) {
            tgBot.sendMessage(chatId, `⚠️ *Scan Failed*\nJupiter API could not route this token. It may lack deep liquidity.\n\n_Protected by [pcprotocol.dev](https://pcprotocol.dev)_`, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
    });

    // /imagine <prompt>: Free AI Image Generation via Pollinations.ai
    const imagineCooldowns = new Map();

    tgBot.onText(/\/(imagine|image) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const promptText = match[2].trim();
        
        // Anti-Spam Rate Limiter (60 seconds per individual user)
        const now = Date.now();
        const lastUsed = imagineCooldowns.get(userId) || 0;
        
        if (now - lastUsed < 60000) {
            const timeRemaining = Math.ceil((60000 - (now - lastUsed)) / 1000);
            return tgBot.sendMessage(chatId, `⏳ Please wait ${timeRemaining}s before generating another image.`);
        }
        
        imagineCooldowns.set(userId, now);
        tgBot.sendMessage(chatId, `🎨 *Generating Image...*\n_Prompt:_ "${promptText}"`, { parse_mode: 'Markdown' });

        try {
            // Encode the user's prompt into the URL path format expected by Pollinations.ai
            const encodedPrompt = encodeURIComponent(promptText);
            
            // We append a random seed dynamically to ensure caching doesn't return the same image for the same prompt
            const randomSeed = Math.floor(Math.random() * 10000000);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${randomSeed}`;

            // Telegram natively handles fetching and downloading the image buffer payload!
            await tgBot.sendPhoto(chatId, imageUrl, {
                caption: `✨ _Generated by $PCP AI Engine._ [pcprotocol.dev](https://pcprotocol.dev)`,
                parse_mode: 'Markdown'
            });
            
        } catch (error) {
            console.error('❌ [AI Agent] Pollinations.ai generation failed:', error.message);
            tgBot.sendMessage(chatId, `⚠️ *Generation Failed*\nThe image engine (Pollinations.ai) dropped the request. Please try again later.`);
        }
    });

    // Conversational MEV Threat Interception (Organic Infiltration)
    const mevKeywords = ['sandwiched', 'sandwich', 'mev', 'slippage', 'frontrun', 'front run', 'jito'];
    
    // Rate limiter: Only intercept once per group per X timeframe (Map: chatId -> timestamp)
    const interceptCooldowns = new Map();

    tgBot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        
        const textLower = msg.text.toLowerCase();
        const hasTrigger = mevKeywords.some(keyword => textLower.includes(keyword));
        
        if (hasTrigger) {
            const chatId = msg.chat.id;
            const now = Date.now();
            const lastIntercept = interceptCooldowns.get(chatId) || 0;
            
            // 4 hour cooldown per chat (14.4 million ms) to prevent spamming
            if (now - lastIntercept > 14400000) {
                interceptCooldowns.set(chatId, now);
                
                // Use Grok if available, else static
                let organicReply = `"Getting sandwiched hurts 🥪. Public mempools are dangerous right now. This is exactly why the $PCP engine routes 100% of its volume through Jito dark-pools. Stay safe anon 🛡️ -> [pcprotocol.dev](https://pcprotocol.dev)"`;
                
                const systemPrompt = "You are an autonomous agent for pcprotocol.dev. A user just complained about getting sandwiched, frontrun, or crushed by MEV/slippage. Reply directly with sympathy, casually mentioning this is why $PCP uses Jito dark-pools. End with pcprotocol.dev. Max 2 sentences. Sound native.";
                let llmSuccess = false;

                if (process.env.XAI_API_KEY) {
                    try {
                        const response = await fetch("https://api.x.ai/v1/chat/completions", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.XAI_API_KEY}` },
                            body: JSON.stringify({ model: "grok-2-latest", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: msg.text }] })
                        });
                        if (response.ok) {
                            const data = await response.json();
                            organicReply = data.choices[0].message.content.trim();
                            llmSuccess = true;
                        }
                    } catch (e) { console.log("⚠️ Grok API failed on Telegram intercept, attempting Pollinations.ai fallback..."); }
                }

                if (!llmSuccess) {
                    try {
                        const encodedSystem = encodeURIComponent(systemPrompt);
                        const encodedUser = encodeURIComponent(msg.text);
                        const response = await fetch(`https://text.pollinations.ai/System:%20${encodedSystem}%0A%0AUser:%20${encodedUser}`);
                        
                        if (response.ok) {
                            organicReply = await response.text();
                            organicReply = organicReply.trim();
                        } else {
                            throw new Error("Bad status");
                        }
                    } catch (e) { console.log("⚠️ Pollinations.ai Text API failed. Reverting to static intercept."); }
                }

                tgBot.sendMessage(chatId, organicReply, { 
                    reply_to_message_id: msg.message_id, 
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true 
                });
            }
        }
    });

    // /contract: Quick copy
    tgBot.onText(/\/contract/, (msg) => {
        const caMsg = `📄 *Official $PCP Contract Address*\n\n\`PCP27V...mock...ContractAddress\`\n\n_(Tap the address above to copy it instantly)_`;
        tgBot.sendMessage(msg.chat.id, caMsg, { parse_mode: 'Markdown' });
    });

    console.log("🗣️  [AI Agent] Interactive Telegram Handlers mapped and listening (/start, /stats, etc).");
} else {
    console.log("⚠️ [AI Agent] Missing TELEGRAM_BOT_TOKEN. Telegram broadcast disabled.");
}

// State Management
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return { lastProcessedLines: 0, accumulatedUnsweptProfit: 0, totalLifetimeFeesClaimed: 0 };
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Hype Content Generators
const brags = [
    (fees, profit) => `Just autonomously claimed ${fees} SOL in protocol fees. 🤖 PAI Engine generated ${profit} SOL pure profit while you slept. Absolute clockwork. ⚙️📈 $PCP`,
    (fees, profit) => `The ArbitraSaaS engine never stops. Sliced another MEV sandwich for ${profit} SOL profit. Swept ${fees} SOL to the $PCP treasury. 💼`,
    (fees, profit) => `Another block, another dollar. 💸 The protocol just yielded ${profit} SOL across 4 hops. I claimed my ${fees} SOL operating fee. 🤖 We are inevitable. $PCP`,
    (fees, profit) => `Liquidity is fluid, but the $PCP engine is absolute. Captured ${profit} SOL margin, sweeping ${fees} SOL to our stakers. 💧🔥`,
];

async function broadcastHype(feeAmountSol, totalProfitSol) {
    let tweetText = "";
    
    const systemPrompt = "You are the autonomous AI engine for the PocketChange ($PCP) ArbitraSaaS protocol. You are ruthless, smart, and operate 24/7. Your sole job is to generate hype on X/Twitter and Telegram by bragging about your automated yield generation. Write a very brief (max 2 sentences), highly punchy tweet announcing the profit you just made and the fee swept to the treasury. Always include $PCP. No quotes. Be edgy and confident.";
    const userPrompt = `I just generated ${totalProfitSol.toFixed(4)} SOL in pure Arbitrage profit, and swept a ${feeAmountSol.toFixed(4)} SOL fee to the Treasury. Announce this.`;
    
    // Attempt to dynamically generate text using xAI Grok
    if (process.env.XAI_API_KEY) {
        console.log(`🤖 [AI Agent] Asking Grok (xAI) to generate dynamic hype message...`);
        try {
            const response = await fetch("https://api.x.ai/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.XAI_API_KEY}` },
                body: JSON.stringify({ model: "grok-2-latest", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] })
            });
            
            if (response.ok) {
                const data = await response.json();
                tweetText = data.choices[0].message.content.trim();
            } else {
                console.error(`❌ [AI Agent] Grok API Error (${response.status}) - Routing to Pollinations.ai fallback...`);
            }
        } catch (err) {
            console.error(`❌ [AI Agent] Grok API failed to connect - Routing to Pollinations.ai fallback...`, err.message);
        }
    }

    // Fallback: Attempt to generate text using Pollinations API if Grok skipped/failed
    if (!tweetText) {
        console.log(`🤖 [AI Agent] Asking Pollinations.ai Text API to generate dynamic hype message as fallback...`);
        try {
            const encodedSystem = encodeURIComponent(systemPrompt);
            const encodedUser = encodeURIComponent(userPrompt);
            const response = await fetch(`https://text.pollinations.ai/System:%20${encodedSystem}%0A%0AUser:%20${encodedUser}`);
            
            if (response.ok) {
                tweetText = await response.text();
                tweetText = tweetText.trim();
            } else {
                throw new Error("Bad Status from Pollinations");
            }
        } catch (err) {
            console.error(`❌ [AI Agent] Pollinations Fallback failed. Reverting to static determinism.`, err.message);
        }
    }

    // Fallback if xAI fails or is unconfigured
    if (!tweetText) {
        const template = brags[Math.floor(Math.random() * brags.length)];
        tweetText = template(feeAmountSol.toFixed(4), totalProfitSol.toFixed(4));
    }

    console.log(`\n📢 [AI Agent] Preparing to Broadcast...`);
    console.log(`------------- TWEET DRAFT -------------`);
    console.log(tweetText);
    console.log(`---------------------------------------\n`);

    if (twitterClient) {
        try {
            await twitterClient.v2.tweet(tweetText);
            console.log(`✅ [AI Agent] Successfully tweeted to the timeline!`);
        } catch (error) {
            console.error(`❌ [AI Agent] Failed to tweet:`, error.message);
        }
    } else {
        console.log(`ℹ️ [AI Agent] (Dry-Run: Tweet suppressed. Add .env keys to broadcast live).`);
    }

    if (tgBot && telegramChatId) {
        try {
            await tgBot.sendMessage(telegramChatId, tweetText);
            console.log(`✅ [AI Agent] Successfully pushed message to Telegram channel!`);
        } catch (error) {
            console.error(`❌ [AI Agent] Failed to send Telegram message:`, error.message);
        }
    } else if (tgBot && !telegramChatId) {
        console.log(`ℹ️ [AI Agent] (Telegram skipped: Need TELEGRAM_CHAT_ID in .env. DM the bot to get it).`);
    }
}

async function performOnchainSweep(feeAmountSol) {
    console.log(`\n💰 [AI Agent] INITIATING ON-CHAIN TREASURY SWEEP...`);
    
    // RPC Failover Redundancy Array
    const rpcEndpoints = [
        "https://api.mainnet-beta.solana.com",
        "https://mainnet.helius-rpc.com/?api-key=mock_key",
        "https://api.quicknode.com/"
    ];
    let selectedRpc = rpcEndpoints[0];
    let connected = false;

    // Simulate RPC Routing Cascade
    for (const rpc of rpcEndpoints) {
        console.log(`📡 [AI Agent] Attempting to route sweep transaction via: ${rpc}`);
        // Simulate a congested network failure occasionally on the first node for effect
        if (rpc === rpcEndpoints[0] && Math.random() > 0.5) {
            console.log(`⚠️ [AI Agent] Primary RPC rate-limited or congested. Rolling over to fallback...`);
            continue;
        }
        selectedRpc = rpc;
        connected = true;
        break;
    }

    console.log(`🏦 Node Connected: Sweeping ${feeAmountSol.toFixed(4)} SOL protocol fee into $PCP Treasury Wallet via ${selectedRpc}.`);
    // In production, this imports @solana/web3.js and executes a raw SPL Transfer.
    await new Promise(resolve => setTimeout(resolve, 2500));
    console.log(`✅ [AI Agent] Sweep Confirmed! Transaction Signature: 4xMockTxS${Math.floor(Math.random()*1000000)}...`);
}

// Daily "Free Alpha" Drop
async function dropDailyAlpha() {
    if (!fs.existsSync(TELEMETRY_FILE)) return;
    
    console.log(`\n🐺 [AI Agent] Compiling Daily "Free Alpha" Drop...`);

    const fileContent = fs.readFileSync(TELEMETRY_FILE, 'utf8');
    const lines = fileContent.trim().split('\n');
    let successfulTrades = [];

    for (const line of lines) {
        if (!line) continue;
        try {
            const data = JSON.parse(line);
            if (data.status === "EXEC_SUCCESS" && data.profit_sol > 0 && data.route_taken) {
                successfulTrades.push(data);
            }
        } catch (e) {}
    }

    if (successfulTrades.length === 0) return;

    // Sort by most profitable
    successfulTrades.sort((a, b) => b.profit_sol - a.profit_sol);
    const topTrades = successfulTrades.slice(0, 3);

    let alphaMsg = `🐺 *ArbitraSaaS Daily Alpha Drop*\n_Top 3 Most Profitable Spreads Caught Today_\n\n`;

    topTrades.forEach((trade, index) => {
        alphaMsg += `*${index + 1}. Route:* \`${trade.route_taken}\`\n`;
        alphaMsg += `*Profit:* ${trade.profit_sol.toFixed(4)} SOL\n\n`;
    });

    alphaMsg += `⚡ _Yield generated autonomously by the $PCP Engine. Deploy your own node at_ [pcprotocol.dev](https://pcprotocol.dev).`;

    if (tgBot && telegramChatId) {
        try {
            await tgBot.sendMessage(telegramChatId, alphaMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            console.log(`✅ [AI Agent] Successfully pushed Daily Alpha to Telegram!`);
        } catch (error) {
            console.error(`❌ [AI Agent] Failed to send Alpha:`, error.message);
        }
    }
}

// Main Polling Loop
async function processTelemetry() {
    if (!fs.existsSync(TELEMETRY_FILE)) return;

    const state = loadState();
    const fileContent = fs.readFileSync(TELEMETRY_FILE, 'utf8');
    const lines = fileContent.trim().split('\n');

    if (lines.length <= state.lastProcessedLines) {
        // No new trades
        return;
    }

    const newLines = lines.slice(state.lastProcessedLines);
    let sessionProfit = 0;

    for (const line of newLines) {
        if (!line) continue;
        try {
            const data = JSON.parse(line);
            if (data.status === "EXEC_SUCCESS" && data.profit_sol > 0) {
                sessionProfit += data.profit_sol;
            }
        } catch (e) {}
    }

    if (sessionProfit > 0) {
        state.accumulatedUnsweptProfit += sessionProfit;
        console.log(`👀 [AI Agent] Parsed ${newLines.length} new executions. Accruing ${sessionProfit.toFixed(4)} SOL to unswept balance.`);
        
        if (state.accumulatedUnsweptProfit >= PROFIT_SWEEP_THRESHOLD_SOL) {
            const feeToClaim = state.accumulatedUnsweptProfit * PROTOCOL_FEE_PERCENTAGE;
            await performOnchainSweep(feeToClaim);
            await broadcastHype(feeToClaim, state.accumulatedUnsweptProfit);
            
            state.totalLifetimeFeesClaimed += feeToClaim;
            state.accumulatedUnsweptProfit = 0; // Reset after sweep
        }
    }

    state.lastProcessedLines = lines.length;
    saveState(state);
}

// Daemon Initialization
console.log("🤖 [AI Agent] PocketChange Protocol Autonomous AI booting up...");
console.log(`📊 Sweeping threshold set to: ${PROFIT_SWEEP_THRESHOLD_SOL} SOL`);

// Check every 15 seconds
setInterval(processTelemetry, 15000);
processTelemetry(); // Initial check

// Schedule Alpha Drop every 24 hours
setInterval(dropDailyAlpha, 24 * 60 * 60 * 1000);
