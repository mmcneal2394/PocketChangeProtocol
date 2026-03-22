/**
 * Trigger a Vercel redeploy via REST API using stored CLI credentials
 */
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

// Vercel stores token after `vercel login` in config file
// Try multiple known locations
const CONFIG_LOCS = [
  path.join(os.homedir(), '.vercel', 'auth.json'),
  path.join(process.env.APPDATA || '', 'Vercel', 'auth.json'),
  path.join(process.env.LOCALAPPDATA || '', 'Vercel', 'auth.json'),
];

let TOKEN = process.env.VERCEL_TOKEN;

if (!TOKEN) {
  for (const loc of CONFIG_LOCS) {
    try {
      const data = JSON.parse(fs.readFileSync(loc, 'utf-8'));
      TOKEN = data.token;
      if (TOKEN) { console.log('Token from:', loc); break; }
    } catch (_) {}
  }
}

if (!TOKEN) {
  // Try extracting from SQLite/keychain — last resort, check npx global config
  const npxBase = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  try {
    const dirs = fs.readdirSync(npxBase);
    for (const d of dirs) {
      const cfg = path.join(npxBase, d, 'node_modules', 'vercel', '.vc-config.json');
      if (fs.existsSync(cfg)) {
        const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
        TOKEN = data.token;
        if (TOKEN) { console.log('Token from vc-config'); break; }
      }
    }
  } catch(_) {}
}

if (!TOKEN) {
  console.error('No token found. Set VERCEL_TOKEN env var or run: vercel login');
  process.exit(1);
}

const PROJECT_ID = 'prj_vVwDvGwCjh0DX2jElHI8qkxfpoPR';
const TEAM_ID    = 'team_6kH88bhXFvkfXhRlsUCV1pm7';

// Get latest deployment and promote it to production, or trigger a new one
function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: 'api.vercel.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }
    }, (res) => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch(_) { resolve(out); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // List recent deployments
  const deps = await apiCall('GET', `/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=5`);
  console.log('Recent deployments:', JSON.stringify(deps?.deployments?.map(d => ({
    uid: d.uid, state: d.state, url: d.url, created: new Date(d.createdAt).toISOString()
  })), null, 2));

  if (!deps?.deployments?.length) {
    console.log('No deployments found. Need to create fresh deploy.');
    process.exit(1);
  }

  // Find most recent non-error deployment to redeploy
  const last = deps.deployments.find(d => d.state !== 'ERROR') || deps.deployments[0];
  console.log('\nRedeploying:', last.uid, last.url);

  const result = await apiCall('POST', `/v12/deployments?teamId=${TEAM_ID}`, {
    name: 'pocket-change-protocol',
    deploymentId: last.uid,
    target: 'production',
  });
  console.log('\nRedeploy result:', JSON.stringify(result, null, 2).slice(0, 500));
}

main().catch(console.error);
