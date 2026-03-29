import { TwitterApi } from 'twitter-api-v2';
import readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Missing TWITTER_CLIENT_ID or TWITTER_CLIENT_SECRET in .env!");
    process.exit(1);
}

const client = new TwitterApi({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

const REDIRECT_URI = 'http://127.0.0.1:3000/callback'; // Even if server isn't running, URL redirect will contain code

async function authenticate() {
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
      REDIRECT_URI, 
      { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] }
  );

  console.log(`\n==========================================`);
  console.log(`PCP SOCIAL MANAGER - ONE-TIME LOGIN WIZARD`);
  console.log(`==========================================\n`);
  console.log(`1. Click this link (make sure you are logged into pcprotocol_ X account):`);
  console.log(`\n${url}\n`);
  console.log(`2. Click "Authorize".`);
  console.log(`3. You will be redirected to an empty/broken page (127.0.0.1).`);
  console.log(`4. Copy the entire URL in your browser address bar and paste it below.`);
  
  const rl = readline.createInterface({
    input: process.env.STUB_STDIN ? process.stdin : process.stdin,
    output: process.stdout
  });

  rl.question('\nPaste the full redirect URL here: ', async (redirectUrlBuffer) => {
    rl.close();
    
    // Extract code from url
    const codeMatch = redirectUrlBuffer.match(/code=([^&]+)/);
    if (!codeMatch) {
       console.error("\n❌ Could not find 'code=' in the URL. Please try again.");
       process.exit(1);
    }
    const code = codeMatch[1];

    try {
      console.log(`\n⏳ Exchanging authorization token...`);
      const { client: loggedClient, accessToken, refreshToken } = await client.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: REDIRECT_URI,
      });

      const me = await loggedClient.v2.me();
      console.log(`\n✅ Authenticated successfully as @${me.data.username} (${me.data.id})`);

      // Save to .env securely
      let envContent = fs.readFileSync(path.join(__dirname, '../.env'), 'utf-8');
      
      const refreshLine = `TWITTER_REFRESH_TOKEN=${refreshToken}`;
      if (envContent.includes('TWITTER_REFRESH_TOKEN=')) {
          envContent = envContent.replace(/TWITTER_REFRESH_TOKEN=.*/, refreshLine);
      } else {
          envContent += `\n${refreshLine}\n`;
      }
      
      fs.writeFileSync(path.join(__dirname, '../.env'), envContent);
      console.log(`\n🎉 Refresh token stored successfully! You are ready to deploy pcp-social!`);
      
    } catch (e: any) {
       console.error(`\n❌ Auth Exchange Failed:`, e?.response?.data || e.message);
    }
  });
}

authenticate();
