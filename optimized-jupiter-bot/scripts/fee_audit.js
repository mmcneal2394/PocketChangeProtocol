/**
 * Fee Audit — reads actual on-chain fee data for every confirmed TX
 * Separates: network base fee / priority fee / slippage / Jupiter platform spread
 *
 * Usage: node scripts/fee_audit.js
 */

require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const fetch = require('node-fetch');
const fs    = require('fs');

const HELIUS = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(HELIUS, { commitment: 'confirmed' });

// Load the v2 summary's confirmed signatures
const summary = JSON.parse(fs.readFileSync('./live5min_v2_summary.json', 'utf-8'));

// All 30 individual leg signatures
const sigs = [];
summary.trades.forEach(t => {
  sigs.push({ sig: t.sig1, leg: 1, symbol: t.symbol, round: summary.trades.indexOf(t) + 1 });
  sigs.push({ sig: t.sig2, leg: 2, symbol: t.symbol, round: summary.trades.indexOf(t) + 1 });
});

async function fetchTxFee(sig) {
  try {
    const tx = await connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;

    const meta = tx.meta;
    const fee  = meta.fee; // total lamports paid as fee (base + priority)

    // Reconstruct CU consumed and priority fee paid
    // fee = base_fee + priority_fee
    // base_fee = 5000 * num_signers (always 5000 for single-signer)
    const baseFee     = 5000;
    const priorityFee = fee - baseFee; // Everything above base is priority
    const cuConsumed  = meta.computeUnitsConsumed || 0;

    // Get pre/post SOL balances for wallet (index 0 = fee payer)
    const preSOL  = meta.preBalances[0];
    const postSOL = meta.postBalances[0];
    const balDelta = (postSOL - preSOL) / 1e9; // net SOL change for this tx

    return {
      sig,
      fee,
      baseFee,
      priorityFee,
      cuConsumed,
      feeSOL:  fee / 1e9,
      balDelta,
      // compute microLamports/CU effectively paid
      effectiveMicroLamPerCU: cuConsumed > 0 ? Math.round(priorityFee / cuConsumed * 1e6) : 0
    };
  } catch(e) {
    return { sig, error: e.message };
  }
}

async function main() {
  const TRADE_SOL = 0.01;
  const TRADE_LAM = Math.floor(TRADE_SOL * 1e9);

  console.log('\n' + '═'.repeat(72));
  console.log('  🔍 ON-CHAIN FEE AUDIT — Jupiter Ultra Round-Trip Transactions');
  console.log('═'.repeat(72));
  console.log(`  Fetching fee data for ${sigs.length} transactions from ${HELIUS.slice(0, 40)}...`);
  console.log();

  const results = [];
  for (const { sig, leg, symbol, round } of sigs) {
    process.stdout.write(`  [${round}/${leg}] ${symbol} LEG${leg}... `);
    const data = await fetchTxFee(sig);
    if (data && !data.error) {
      results.push({ ...data, leg, symbol, round });
      console.log(`fee: ${data.fee} lamports  CU: ${data.cuConsumed.toLocaleString()}  Δ${(data.balDelta >= 0 ? '+' : '')}${data.balDelta.toFixed(6)} SOL`);
    } else {
      console.log(`❌ ${data?.error || 'not found'}`);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log('\n' + '─'.repeat(72));
  console.log('  📊 AGGREGATE FEE BREAKDOWN');
  console.log('─'.repeat(72));

  const valid = results.filter(r => !r.error);
  const totalFee    = valid.reduce((s, r) => s + r.fee, 0);
  const totalBase   = valid.reduce((s, r) => s + r.baseFee, 0);
  const totalPriority = valid.reduce((s, r) => s + r.priorityFee, 0);
  const totalCU     = valid.reduce((s, r) => s + r.cuConsumed, 0);
  const avgCU       = Math.round(totalCU / valid.length);
  const avgFee      = Math.round(totalFee / valid.length);
  const avgPriority = Math.round(totalPriority / valid.length);
  const avgEffMicroLam = Math.round(valid.reduce((s, r) => s + r.effectiveMicroLamPerCU, 0) / valid.length);

  // Per round-trip costs
  const roundCount = summary.trades.length;
  const feePerRound = (totalFee / roundCount) / 1e9;
  const totalDelta  = summary.stats.delta;
  // Total slippage = total delta - total fees (slippage is priced by Jupiter, fees are on-chain)
  const totalFeeSOL = totalFee / 1e9;
  const slippageCost = Math.abs(totalDelta) - totalFeeSOL;

  console.log(`  Transactions analyzed:    ${valid.length} / ${sigs.length}`);
  console.log();
  console.log(`  PER TRANSACTION:`);
  console.log(`    Avg total fee:          ${avgFee.toLocaleString()} lamports  (${(avgFee/1e9).toFixed(6)} SOL)`);
  console.log(`    Avg base fee:           5,000 lamports  (${(5000/1e9).toFixed(6)} SOL)`);
  console.log(`    Avg priority fee:       ${avgPriority.toLocaleString()} lamports  (${(avgPriority/1e9).toFixed(6)} SOL)`);
  console.log(`    Avg CU consumed:        ${avgCU.toLocaleString()} CU`);
  console.log(`    Effective microLam/CU:  ${avgEffMicroLam.toLocaleString()} (what you actually paid)`);
  console.log();
  console.log(`  PER ROUND-TRIP (2 legs):`);
  console.log(`    Network fees:           ${(feePerRound).toFixed(6)} SOL  (${((feePerRound/TRADE_SOL)*100).toFixed(2)}% of trade)`);
  console.log(`    Slippage + spread:      ${slippageCost.toFixed(6)} SOL  (${((slippageCost/(TRADE_SOL*roundCount))*100).toFixed(2)}% of trade)`);
  console.log(`    Total cost per round:   ${(Math.abs(totalDelta)/roundCount).toFixed(6)} SOL`);
  console.log();
  console.log(`  PRIORITY FEE EFFICIENCY:`);

  // Check if we're overpaying priority fees
  // Jupiter Ultra handles CU budget natively, so our jarvis_v3 300k microLam × 1.4M CU = 0.00042 SOL would be wasteful
  // But for Ultra API, Jupiter optimizes this
  const projectedJarvisV3Fee = (300000 * 1400000) / 1e12; // in SOL: 300k microLam * 1.4M CU / 1e12
  const projectedOptimizedFee = (avgEffMicroLam * avgCU) / 1e12;
  console.log(`    Actual avg microLam/CU: ${avgEffMicroLam.toLocaleString()}`);
  console.log(`    jarvis_v3 sets:         300,000 microLam × 1,400,000 CU = ${(projectedJarvisV3Fee).toFixed(5)} SOL/tx  ← POTENTIAL OVERPAY`);
  console.log(`    Optimal (match actual): ${avgEffMicroLam.toLocaleString()} microLam × ${avgCU.toLocaleString()} CU = ${(projectedOptimizedFee).toFixed(6)} SOL/tx`);
  console.log(`    Savings per tx:         ${((projectedJarvisV3Fee - projectedOptimizedFee)).toFixed(5)} SOL`);
  console.log();
  console.log(`  VERDICT:`);
  const breakEvenProfitNeeded = (Math.abs(totalDelta)/roundCount);

  if (slippageCost < feePerRound) {
    console.log(`    ✅ Slippage (${slippageCost.toFixed(6)} SOL) < Net fees (${feePerRound.toFixed(6)} SOL)`);
    console.log(`       Main cost is network fees — priority fee optimization will help most`);
  } else {
    console.log(`    ⚠️  Slippage (${slippageCost.toFixed(6)} SOL) > Net fees (${feePerRound.toFixed(6)} SOL)`);
    console.log(`       Main cost is price slippage — tighter spreads or smaller slippage BPS needed`);
  }
  console.log(`    Break-even needs:       >${breakEvenProfitNeeded.toFixed(6)} SOL arbitrage per round-trip`);
  console.log(`    At 0.1 SOL trade size:  ${((breakEvenProfitNeeded/TRADE_SOL)*100).toFixed(2)}% spread needed to profit`);
  console.log(`    At 0.25 SOL trade size: ${((breakEvenProfitNeeded/0.25)*100).toFixed(2)}% spread needed to profit`);

  console.log('\n' + '═'.repeat(72));

  // Save full audit
  fs.writeFileSync('./fee_audit_results.json', JSON.stringify({ results, summary: { avgFee, avgPriority, avgCU, avgEffMicroLam, feePerRound, slippageCost, totalDelta } }, null, 2));
  console.log('  📄 Full audit → fee_audit_results.json\n');
}

main().catch(e => { console.error('❌ FATAL:', e.message); process.exit(1); });
