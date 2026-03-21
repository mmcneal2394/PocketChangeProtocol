/**
 * PM2: ngrok-keeper
 * Starts ngrok on port 3002, monitors the tunnel URL,
 * and auto-updates the Vercel ENGINE_API_URL env var + redeploys
 * whenever the URL changes (e.g. after a restart).
 */
'use strict';
const { execSync, spawn } = require('child_process');
const https = require('https');

const VERCEL_PROJECT = 'pocket-change-protocol';
const DEPLOY_DIR     = 'C:\\Users\\admin\\AppData\\Local\\Temp\\pcp_deploy';
const CHECK_MS       = 10_000; // poll ngrok every 10s

let currentUrl = null;
let ngrokProc  = null;

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [ngrok-keeper] ${m}`); }

function getNgrokUrl() {
  return new Promise((resolve) => {
    const req = https.request({ host: 'localhost', port: 4040, path: '/api/tunnels' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const t = JSON.parse(d).tunnels.find(t => t.proto === 'https');
          resolve(t?.public_url || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function startNgrok() {
  log('Starting ngrok http 3002...');
  ngrokProc = spawn('ngrok', ['http', '3002', '--log=false'], { stdio: 'ignore', detached: false });
  ngrokProc.on('exit', (code) => { log(`ngrok exited (${code}) — restarting in 3s`); setTimeout(startNgrok, 3000); });
}

function updateVercel(newUrl) {
  log(`New tunnel URL: ${newUrl} — updating Vercel env...`);
  const fullUrl = `${newUrl}/api/status`;
  try {
    execSync(`npx vercel@latest env rm ENGINE_API_URL production --yes`, { cwd: DEPLOY_DIR, stdio: 'pipe' });
  } catch(_) {}
  // Write URL to temp file (no newline) and pipe it in
  const fs = require('fs');
  fs.writeFileSync('C:\\Users\\admin\\AppData\\Local\\Temp\\engine_url.txt', fullUrl);
  try {
    execSync(
      `powershell -Command "Get-Content C:\\Users\\admin\\AppData\\Local\\Temp\\engine_url.txt | npx vercel@latest env add ENGINE_API_URL production"`,
      { cwd: DEPLOY_DIR, stdio: 'pipe' }
    );
    log('ENGINE_API_URL updated ✅');
    // Trigger redeploy
    execSync(`npx vercel@latest --prod --yes`, { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 300_000 });
    log('Vercel redeploy triggered ✅');
    currentUrl = newUrl;
  } catch(e) {
    log(`Vercel update failed: ${e.message.slice(0,80)}`);
  }
}

async function monitor() {
  const url = await getNgrokUrl();
  if (!url) {
    log('ngrok not ready yet...');
  } else if (url !== currentUrl) {
    log(`URL changed: ${currentUrl || 'none'} → ${url}`);
    await updateVercel(url);
  }
}

// Start
startNgrok();
setTimeout(async () => {
  // Wait for ngrok to init
  await new Promise(r => setTimeout(r, 4000));
  await monitor();
  setInterval(monitor, CHECK_MS);
}, 1000);
