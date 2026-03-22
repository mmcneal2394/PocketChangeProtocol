/**
 * REFERRAL TRACKING API
 * Lightweight Express server for referral program data.
 * Stores in referral_data.json — swap data posted by arb/sniper engines.
 *
 * Endpoints:
 *   POST /api/register        { wallet } → { code, link }
 *   GET  /api/stats/:wallet   → { referrals, volume_sol, earned_sol, rank }
 *   POST /api/swap            { referrer, volume_sol, fee_sol } → logged
 *   GET  /api/leaderboard     → top 10 referrers
 *   GET  /api/total           → platform totals
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '../referral_data.json');
const PORT = process.env.REFERRAL_PORT || 3001;
const REFERRER_SPLIT = 0.5; // 50% of platform fee → referrer

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { referrers: {}, codes: {}, swaps: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch(_) { return { referrers: {}, codes: {}, swaps: [] }; }
}
function save(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(obj));
}

function stats(data, wallet) {
  const r = data.referrers[wallet];
  if (!r) return null;
  const mySwaps = data.swaps.filter(s => s.referrer === wallet);
  const volume  = mySwaps.reduce((a, s) => a + (s.volume_sol||0), 0);
  const earned  = mySwaps.reduce((a, s) => a + (s.referrer_earn||0), 0);
  const allEarned = Object.entries(data.referrers).map(([w]) => {
    const sw = data.swaps.filter(s => s.referrer === w);
    return { wallet: w, earned: sw.reduce((a,s)=>a+(s.referrer_earn||0),0) };
  }).sort((a,b) => b.earned - a.earned);
  const rank = allEarned.findIndex(e => e.wallet === wallet) + 1;
  return { wallet, code: r.code, link: r.link, referrals: r.referred?.length||0, volume_sol: +volume.toFixed(6), earned_sol: +earned.toFixed(6), rank, swaps: mySwaps.length };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }

  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const data = loadData();
    const url  = req.url.split('?')[0];

    // POST /api/register
    if (req.method === 'POST' && url === '/api/register') {
      try {
        const { wallet } = JSON.parse(body);
        if (!wallet || wallet.length < 32) return json(res, 400, { error: 'invalid wallet' });
        if (!data.referrers[wallet]) {
          const code = crypto.randomBytes(4).toString('hex');
          const link = `https://pcprotocol.dev/?ref=${wallet}`;
          data.referrers[wallet] = { code, link, referred: [], joined: new Date().toISOString() };
          data.codes = data.codes || {};
          data.codes[code] = wallet;
          save(data);
        }
        return json(res, 200, { wallet, ...data.referrers[wallet] });
      } catch(e) { return json(res, 400, { error: e.message }); }
    }

    // GET /api/stats/:wallet
    if (req.method === 'GET' && url.startsWith('/api/stats/')) {
      const wallet = url.split('/api/stats/')[1];
      const s = stats(data, wallet);
      return s ? json(res, 200, s) : json(res, 404, { error: 'wallet not registered' });
    }

    // POST /api/swap — called by arb engine to log a referred swap
    if (req.method === 'POST' && url === '/api/swap') {
      try {
        const { referrer, volume_sol, fee_sol, token, sig } = JSON.parse(body);
        if (!referrer || !volume_sol) return json(res, 400, { error: 'missing fields' });
        const referrer_earn = (fee_sol||0) * REFERRER_SPLIT;
        data.swaps.push({ ts: new Date().toISOString(), referrer, volume_sol, fee_sol: fee_sol||0, referrer_earn, token: token||'?', sig: sig||'' });
        if (data.referrers[referrer] && !data.referrers[referrer].referred.includes(sig)) {
          data.referrers[referrer].referred.push(sig||ts);
        }
        save(data);
        return json(res, 200, { logged: true, referrer_earn });
      } catch(e) { return json(res, 400, { error: e.message }); }
    }

    // GET /api/leaderboard
    if (req.method === 'GET' && url === '/api/leaderboard') {
      const lb = Object.keys(data.referrers).map(w => {
        const s = stats(data, w);
        return { wallet: w.slice(0,6)+'...'+w.slice(-4), full: w, earned_sol: s?.earned_sol||0, referrals: s?.referrals||0, swaps: s?.swaps||0 };
      }).sort((a,b) => b.earned_sol - a.earned_sol).slice(0,10);
      return json(res, 200, lb);
    }

    // GET /api/total
    if (req.method === 'GET' && url === '/api/total') {
      const total_vol   = data.swaps.reduce((a,s)=>a+(s.volume_sol||0),0);
      const total_fees  = data.swaps.reduce((a,s)=>a+(s.fee_sol||0),0);
      const total_paid  = data.swaps.reduce((a,s)=>a+(s.referrer_earn||0),0);
      return json(res, 200, { referrers: Object.keys(data.referrers).length, swaps: data.swaps.length,
        total_volume_sol: +total_vol.toFixed(4), total_fees_sol: +total_fees.toFixed(6), total_paid_sol: +total_paid.toFixed(6) });
    }

    json(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, () => {
  console.log(`\n🔗 Referral API running on http://localhost:${PORT}`);
  console.log(`   Endpoints: /api/register  /api/stats/:wallet  /api/leaderboard  /api/total`);
});
