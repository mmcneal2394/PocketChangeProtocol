'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT     = 3002;
const ARB_LOG  = path.join(os.homedir(), '.pm2', 'logs', 'arb-jup-out.log');
const SNIP_LOG = path.join(os.homedir(), '.pm2', 'logs', 'sniper-out.log');

// Parse live stats from log
function parseStats() {
  let lines = [];
  try { lines = fs.readFileSync(ARB_LOG, 'utf8').split('\n').filter(Boolean); } catch(_) {}
  const recent = lines.slice(-300);

  let scans = 0, trades = 0, profits = 0, losses = 0, netSol = 0, tradeSizeSol = 0.05;
  const tradeEvents = [];
  const lastScans   = [];

  for (const l of recent) {
    if (l.includes('Scan #')) {
      scans++;
      const mNet  = l.match(/net:([+-]?\d+\.\d+)/);
      const mSize = l.match(/size:(\d+\.\d+)SOL/);
      if (mNet)  netSol      = parseFloat(mNet[1]);
      if (mSize) tradeSizeSol = parseFloat(mSize[1]);
      lastScans.push(l.replace(/^.*\|arb-jup\s*\|\s*/, '').trim());
      if (lastScans.length > 8) lastScans.shift();
    }
    if (l.match(/⚡|executing/)) { trades++; profits++; }
    if (l.includes('LEG1 err') || l.includes('LEG2 err')) losses++;
    if (l.includes('solscan.io/tx') && l.includes('LEG')) {
      const m = l.match(/https:\/\/solscan\.io\/tx\/(\S+)/);
      if (m) tradeEvents.push({ tx: m[1], line: l.trim().slice(-80), ts: new Date().toISOString().slice(11,19) });
    }
  }

  let sniperLines = [];
  try { sniperLines = fs.readFileSync(SNIP_LOG,'utf8').split('\n').filter(Boolean).slice(-5); } catch(_) {}

  return { scans, trades, profits, losses, netSol, tradeSizeSol,
    lastScans: lastScans.slice(-6), tradeEvents: tradeEvents.slice(-10),
    sniperStatus: sniperLines.slice(-2).join(' | ').slice(0,120) };
}

// ── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARB-JUP Live Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#080c14;color:#e2e8f0;font-family:'Inter',sans-serif;min-height:100vh;padding:20px}
  h1{font-size:1.4rem;font-weight:700;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
  .sub{font-size:.75rem;color:#64748b;margin-bottom:20px;font-family:'JetBrains Mono',monospace}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
  .card{background:linear-gradient(135deg,#0f172a,#1e293b);border:1px solid #1e3a5f;border-radius:12px;padding:16px}
  .card .label{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:6px}
  .card .val{font-size:1.6rem;font-weight:700;font-family:'JetBrains Mono',monospace}
  .card .val.green{color:#34d399} .card .val.red{color:#f87171} .card .val.blue{color:#60a5fa} .card .val.yellow{color:#fbbf24}
  .panel{background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;margin-bottom:16px}
  .panel h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#38bdf8;margin-bottom:12px;font-weight:600}
  .log-line{font-family:'JetBrains Mono',monospace;font-size:.7rem;padding:3px 0;border-bottom:1px solid #0c1727;color:#94a3b8}
  .log-line.green{color:#34d399} .log-line.red{color:#f87171} .log-line.yellow{color:#fbbf24}
  .tx-link{color:#60a5fa;text-decoration:none;font-size:.65rem} .tx-link:hover{text-decoration:underline}
  .pulse{width:8px;height:8px;border-radius:50%;background:#34d399;display:inline-block;animation:pulse 2s infinite;margin-right:6px}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .status-bar{display:flex;align-items:center;font-size:.75rem;color:#64748b;margin-bottom:20px}
  .badge{padding:2px 8px;border-radius:4px;font-size:.65rem;font-weight:600;margin-left:8px}
  .badge.live{background:#052e16;color:#34d399;border:1px solid #166534}
  .badge.tracking{background:#1e1a4f;color:#818cf8;border:1px solid #3730a3}
  footer{text-align:center;color:#334155;font-size:.65rem;margin-top:20px}
</style>
</head>
<body>
<h1>🤖 ARB-JUP Live Engine</h1>
<div class="sub">Wallet: DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj · Jupiter Ultra API · 0.2% referral fee active</div>
<div class="status-bar">
  <span class="pulse"></span> Live
  <span class="badge live">arb-jup ONLINE</span>
  <span class="badge tracking">24h tracking</span>
  <span id="clock" style="margin-left:auto;font-family:'JetBrains Mono',monospace"></span>
</div>

<div class="grid">
  <div class="card"><div class="label">Scans</div><div class="val blue" id="scans">—</div></div>
  <div class="card"><div class="label">Trades</div><div class="val yellow" id="trades">—</div></div>
  <div class="card"><div class="label">Profits ✅</div><div class="val green" id="profits">—</div></div>
  <div class="card"><div class="label">Errors ❌</div><div class="val red" id="losses">—</div></div>
  <div class="card"><div class="label">Net PnL</div><div class="val" id="net">—</div></div>
  <div class="card"><div class="label">Trade Size</div><div class="val blue" id="size">—</div></div>
</div>

<div class="panel">
  <h2>Live Scan Output</h2>
  <div id="scanlog"></div>
</div>

<div class="panel">
  <h2>Trade Events</h2>
  <div id="trades-log"><div class="log-line" style="color:#334155">Waiting for first trade...</div></div>
</div>

<div class="panel">
  <h2>Sniper Status</h2>
  <div id="sniper" class="log-line" style="color:#64748b">Loading...</div>
</div>

<footer>Updates every 3s · <a href="https://solscan.io/account/DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj" target="_blank" class="tx-link">View wallet on Solscan</a> · <a href="https://solscan.io/account/TxW2V7LxCr9HtPW1cCn1gAwmgpP4eKCci9tJVw2rGDQ" target="_blank" class="tx-link">Fee account</a></footer>

<script>
let lastScans=[], lastTrades=[];
async function update(){
  try{
    const d=await fetch('/api/status').then(r=>r.json());
    document.getElementById('scans').textContent=d.scans.toLocaleString();
    document.getElementById('trades').textContent=d.trades;
    document.getElementById('profits').textContent=d.profits;
    document.getElementById('losses').textContent=d.losses;
    const net=d.netSol;
    const el=document.getElementById('net');
    el.textContent=(net>=0?'+':'')+net.toFixed(5)+' SOL';
    el.className='val '+(net>0?'green':net<0?'red':'');
    document.getElementById('size').textContent=d.tradeSizeSol.toFixed(3)+' SOL';
    // Scan log
    const sl=document.getElementById('scanlog');
    sl.innerHTML=d.lastScans.map(l=>{
      const c=l.includes('🟢')?'green':l.includes('🔴')?'red':l.includes('🟡')?'yellow':'';
      return '<div class="log-line '+c+'">'+l.replace(/</g,'&lt;')+'</div>';
    }).join('');
    // Trades
    if(d.tradeEvents.length){
      document.getElementById('trades-log').innerHTML=d.tradeEvents.slice(-8).reverse().map(e=>
        '<div class="log-line green">'+e.ts+' <a class="tx-link" href="https://solscan.io/tx/'+e.tx+'" target="_blank">'+e.tx.slice(0,20)+'...</a></div>'
      ).join('');
    }
    document.getElementById('sniper').textContent=d.sniperStatus||'Watching...';
  }catch(e){}
  document.getElementById('clock').textContent=new Date().toISOString().slice(11,19)+' UTC';
}
update();
setInterval(update,3000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(parseStats()));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`[dashboard] Live at http://localhost:${PORT}`);
});
