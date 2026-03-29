const fs = require('fs');

const envPath = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env';
let env = fs.readFileSync(envPath, 'utf8');

const apiKey = 'AIzaSyDJfu4Egz0_TKnuYYoZAkQAKvovABdzoy4';

if (env.includes('GEMINI_API_KEY=')) {
    env = env.replace(/^GEMINI_API_KEY=.*$/gm, `GEMINI_API_KEY=${apiKey}`);
} else {
    env += `\nGEMINI_API_KEY=${apiKey}\n`;
}

fs.writeFileSync(envPath, env);
console.log('Successfully injected GEMINI_API_KEY into .env.');
