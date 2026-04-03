import { TwitterApi } from 'twitter-api-v2';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { deployToken } from './deployer_engine';
import { loopVolume } from './deployer_volume';

dotenv.config({ path: path.join(process.cwd(), '.env') });

// ── 1. Init APIs ─────────────────────────────────────────────────────────────
// Use application-only Bearer Token for Search (higher rate limits)
const twitterSearchClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN!);

// Use OAuth 1.0a User Context for Replying
const twitterUserClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
});

// Init Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function downloadImage(url: string, dest: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
}

async function generateMemeMeta(tweetText: string): Promise<{name: string, ticker: string, description: string}> {
    const prompt = `
You are an expert crypto degen and meme-coin creator. Based on the following viral tweet text, generate a highly engaging, hype-driven Meme Coin Name, a 3-4 letter Ticker Symbol, and a short 1-sentence description that explains the meme context. Do not use hashtags.
Return ONLY raw JSON, with no markdown code blocks, in this exact format:
{
  "name": "Token Name",
  "ticker": "TCK",
  "description": "Short meme explanation."
}

Viral Tweet Text:
"${tweetText}"
`;

    let text = "{}";
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        text = response.text || "{}";
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    } catch (e) {
        console.warn(`[META-EXTRACTOR] ⚠️ AI Generation Failed. Injecting deterministic Fallback Metadata.`);
        text = JSON.stringify({
            "name": "Doge Acceleration Matrix",
            "ticker": "DAM",
            "description": "The absolute craziest bull run of our generation is starting right now! Send it higher!"
        });
    }
    
    return JSON.parse(text);
}

export async function runViralExtraction(
    initialBuySol: number = 0.03,
    volumeCycles: number = 5,
    volumeSizeSol: number = 0.05
) {
    console.log(`\n=== PCP VIRAL EXTRACTOR DAEMON ===`);
    console.log(`[META-EXTRACTOR] 🦅 Scanning X (Twitter) for recent viral image posts...`);

    const TMP_IMG_PATH = path.join(process.cwd(), 'signals', `viral_meta_${Date.now()}.jpg`);
    
    // ── 2. Query Twitter for Viral Post ──────────────────────────────────────
    const searchParams = {
        query: "viral OR trending OR meme has:images -is:retweet",
        "tweet.fields": ["public_metrics", "created_at", "text"],
        "expansions": ["attachments.media_keys", "author_id"],
        "media.fields": ["url"],
        max_results: 10
    };

    let apexTweet;
    let imageUrl = '';
    
    let fallbackText = "";

    try {
        const searchResponse = await twitterSearchClient.v2.search(searchParams.query, {
             // @ts-ignore
             expansions: searchParams.expansions,
             // @ts-ignore
             "tweet.fields": searchParams["tweet.fields"],
             // @ts-ignore
             "media.fields": searchParams["media.fields"],
             max_results: searchParams.max_results
        });

        const tweets = searchResponse.tweets;
        if (tweets && tweets.length > 0) {
            tweets.sort((a, b) => b.public_metrics!.like_count - a.public_metrics!.like_count);
            apexTweet = tweets[0];
            
            const includes = searchResponse.includes;
            if (apexTweet.attachments?.media_keys && includes?.media) {
                 const mediaId = apexTweet.attachments.media_keys[0];
                 const mediaObj = includes.media.find(m => m.media_key === mediaId);
                 if (mediaObj && mediaObj.url) imageUrl = mediaObj.url;
            }
        }
    } catch (e: any) {
        console.warn(`[META-EXTRACTOR] ⚠️ Twitter Search API Auth Limit hit. Engaging Autonomous AI Fallback.`);
    }

    if (!apexTweet || !imageUrl) {
         console.warn(`[META-EXTRACTOR] ⚠️ No live image secured. Generating 100% unique AI Meme asset...`);
         
         // 1. Generate a completely unique prompt via Gemini first to drive the image generator
         const conceptPrompt = "Generate a completely unique, absurd, and hyper-viral concept for an internet phenomenon. Could be a bizarre animal, an epic situation, retro synthwave gear, or a wild conspiracy. Return only a 1-sentence tweet describing it.";
         try {
             const aiResp = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: conceptPrompt });
             fallbackText = aiResp.text || "A neon cyberpunk cat drinking coffee on Mars!";
         } catch(e) {
             fallbackText = "A raccoon wearing tiny sunglasses eating pizza on a skateboard.";
         }

         apexTweet = { 
             id: 'fallback_ai_' + Date.now(), 
             text: fallbackText, 
             public_metrics: { like_count: Math.floor(Math.random() * 50000) + 10000 } 
         };

         // 2. Generate a 100% Unique Image via Free Pollinations Generative API
         const encodedPrompt = encodeURIComponent(`Hyper realistic aesthetic viral image featuring: ${fallbackText}. Vibrant, bold, center composition, 4k, cinematic lightning.`);
         const randomSeed = Math.floor(Math.random() * 1000000);
         imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&seed=${randomSeed}`;
    }

    console.log(`[META-EXTRACTOR] 🎯 Secured Viral Context (${apexTweet.public_metrics!.like_count} likes)!`);
    console.log(`   └─ Source Text: "${apexTweet.text.substring(0, 60)}..."`);
    
    // ── 3. Parse and Download Metadata ───────────────────────────────────────
    console.log(`[META-EXTRACTOR] 🛸 Downloading unique asset image...`);
    await downloadImage(imageUrl, TMP_IMG_PATH);

    console.log(`[META-EXTRACTOR] 🧠 Pushing viral text to Gemini AI for Token Data JSON generation...`);
    const genData = await generateMemeMeta(apexTweet.text);
    console.log(`   └─ Name: ${genData.name}`);
    console.log(`   └─ Ticker: ${genData.ticker}`);
    console.log(`   └─ Desc: ${genData.description}`);

    // ── 4. Token Deployment Pipeline ─────────────────────────────────────────
    console.log(`[META-EXTRACTOR] 🚀 Piping AI payload straight into Pump.fun Deployer Engine...`);
    
    const deployment = await deployToken(
        genData.name,
        genData.ticker,
        genData.description,
        TMP_IMG_PATH,
        initialBuySol
    );

    console.log(`[META-EXTRACTOR] 🌊 Igniting Wash Volume Matrix (${volumeCycles} cycles)...`);
    // Wait for the chain to confirm the token creation before buying it heavily
    await new Promise(r => setTimeout(r, 6000));
    await loopVolume(deployment.mint, volumeCycles, volumeSizeSol, 2000);

    // ── 5. The Momentum Tie-In (Auto-Reply) ──────────────────────────────────
    console.log(`[META-EXTRACTOR] 🐦 Replying to viral tweet with Pump.fun Link...`);
    const pumpLink = `https://pump.fun/${deployment.mint}`;
    try {
        await twitterUserClient.v2.reply(
             `The market moves fast. Just collateralized this into $${genData.ticker} purely for the meme: ${pumpLink}`, 
             apexTweet.id
        );
        console.log(`[META-EXTRACTOR] ✅ Momentum Hook successfully planted!`);
    } catch (e: any) {
        console.error(`[META-EXTRACTOR] ❌ Failed to post Twitter auto-reply: ${e.message}`);
    }
}

if (require.main === module) {
    console.log("=== PCP VIRAL EXTRACTOR DAEMON ===");
    runViralExtraction(0.03, 5, 0.005).catch(console.error); // 0.03 SOL Initial Dev Bag
}
