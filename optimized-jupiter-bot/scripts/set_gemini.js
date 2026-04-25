const fs = require('fs');
const path = require('path');

const envPath = process.env.PCP_ENV_PATH || path.join(__dirname, '..', '.env');
const apiKey = process.env.GOOGLE_API_KEY?.trim();

if (!apiKey) {
    console.error('GOOGLE_API_KEY is not set.');
    process.exit(1);
}

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (env.includes('GEMINI_API_KEY=')) {
    env = env.replace(/^GEMINI_API_KEY=.*$/gm, `GEMINI_API_KEY=${apiKey}`);
} else {
    env += `\nGEMINI_API_KEY=${apiKey}\n`;
}

fs.writeFileSync(envPath, env.trimStart() ? env : `GEMINI_API_KEY=${apiKey}\n`);
console.log(`Successfully injected GEMINI_API_KEY into ${envPath}.`);
