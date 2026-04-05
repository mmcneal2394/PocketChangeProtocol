require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const c = new Connection(process.env.RPC_ENDPOINT);
const w = 'DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13';

async function main() {
  // Get ALL recent signatures (up to 1000)
  let allSigs = [];
  let before = undefined;
  for (let i = 0; i < 5; i++) {
    const opts = { limit: 200 };
    if (before) opts.before = before;
    const sigs = await c.getSignaturesForAddress(new PublicKey(w), opts);
    if (sigs.length === 0) break;
    allSigs = allSigs.concat(sigs);
    before = sigs[sigs.length - 1].signature;
  }
  
  // Group by hour
  const hourly = {};
  let totalFail = 0;
  let totalOk = 0;
  
  for (const s of allSigs) {
    const d = new Date(s.blockTime * 1000);
    const hour = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    if (!hourly[hour]) hourly[hour] = { ok: 0, fail: 0 };
    if (s.err) { hourly[hour].fail++; totalFail++; }
    else { hourly[hour].ok++; totalOk++; }
  }
  
  console.log('=== TRANSACTION VOLUME BY HOUR ===');
  console.log('Hour (UTC)         OK   FAIL  Total');
  console.log('-'.repeat(50));
  
  const sorted = Object.entries(hourly).sort();
  for (const [hour, data] of sorted) {
    const total = data.ok + data.fail;
    const failPct = ((data.fail / total) * 100).toFixed(0);
    console.log(`${hour}:00    ${String(data.ok).padStart(4)}  ${String(data.fail).padStart(4)}  ${String(total).padStart(5)}  (${failPct}% fail)`);
  }
  
  console.log();
  console.log(`TOTALS: ${totalOk} OK | ${totalFail} FAILED | ${allSigs.length} total`);
  console.log(`Overall fail rate: ${((totalFail / allSigs.length) * 100).toFixed(1)}%`);
  
  // Gas estimate for failed txs at various fee levels
  console.log();
  console.log('=== GAS IMPACT OF FAILED TXS ===');
  console.log(`At 5K lamports:   ${(totalFail * 0.000005).toFixed(6)} SOL`);
  console.log(`At 250K lamports: ${(totalFail * 0.00025).toFixed(6)} SOL`);
  console.log(`At 5M lamports:   ${(totalFail * 0.005).toFixed(6)} SOL`);
  
  // Time span
  if (allSigs.length > 0) {
    const oldest = new Date(allSigs[allSigs.length-1].blockTime * 1000);
    const newest = new Date(allSigs[0].blockTime * 1000);
    const hours = (newest - oldest) / 3600000;
    console.log(`\nTime span: ${hours.toFixed(1)} hours (${oldest.toISOString()} to ${newest.toISOString()})`);
    console.log(`Avg txns/hour: ${(allSigs.length / hours).toFixed(0)}`);
  }
}
main();
