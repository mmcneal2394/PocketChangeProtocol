#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const signalsDir = path.join(root, 'signals');
const statsFile = path.join(signalsDir, process.env.PAPER_MODE === 'true' ? 'trade_profile_stats_paper.json' : 'trade_profile_stats.json');
const eventsFile = path.join(signalsDir, process.env.PAPER_MODE === 'true' ? 'trade_profile_events_paper.jsonl' : 'trade_profile_events.jsonl');
const journalFile = path.join(signalsDir, process.env.PAPER_MODE === 'true' ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const lookbackHours = Math.max(1, parseInt(process.env.TRADE_PROFILE_LOOKBACK_HOURS || '24', 10) || 24);
const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fmtSol(n) {
  const value = Number(n || 0);
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)} SOL`;
}

function fmtPct(n) {
  const value = Number(n || 0) * 100;
  return `${value.toFixed(1)}%`;
}

function rankBuckets(dimensionMap) {
  return Object.entries(dimensionMap || {})
    .filter(([, data]) => (data?.trades || 0) > 0)
    .sort((a, b) => (b[1].avgPnlSol || 0) - (a[1].avgPnlSol || 0));
}

const stats = readJson(statsFile, {});
const events = readJsonl(eventsFile).filter(evt => Number(evt.ts || 0) >= cutoff);
const journal = readJsonl(journalFile).filter(evt => Number(evt.ts || 0) >= cutoff);

const buyEvents = events.filter(evt => evt.action === 'BUY');
const sellEvents = events.filter(evt => evt.action === 'SELL');
const wins = sellEvents.filter(evt => Number(evt.pnlSol || 0) >= 0);
const losses = sellEvents.filter(evt => Number(evt.pnlSol || 0) < 0);
const totalPnl = sellEvents.reduce((sum, evt) => sum + Number(evt.pnlSol || 0), 0);
const avgHoldMin = sellEvents.length
  ? sellEvents.reduce((sum, evt) => sum + Number(evt.holdMs || 0), 0) / sellEvents.length / 60000
  : 0;

const recentRejects = journal
  .filter(evt => evt.action !== 'BUY' && evt.action !== 'SELL' && evt.reason)
  .slice(-10);

console.log(`Trade learning summary | lookback=${lookbackHours}h`);
console.log(`Buys: ${buyEvents.length} | Closed trades: ${sellEvents.length} | Wins: ${wins.length} | Losses: ${losses.length} | Win rate: ${sellEvents.length ? fmtPct(wins.length / sellEvents.length) : 'n/a'} | PnL: ${fmtSol(totalPnl)} | Avg hold: ${avgHoldMin.toFixed(1)}m`);

if (buyEvents.length > 0) {
  const latestBuys = buyEvents.slice(-5).map(evt => {
    const profile = evt.profile || {};
    return `${evt.symbol} [${profile.ageBucket || 'unknown'} | liq ${profile.liquidityBucket || 'unknown'} | mcap ${profile.marketCapBucket || 'unknown'} | 5m ${profile.momentum5mBucket || 'unknown'} | 1m ${profile.momentum1mBucket || 'unknown'}]`;
  });
  console.log(`Recent entries: ${latestBuys.join(' ; ')}`);
}

const dimensions = stats.dimensions || {};
for (const dimension of ['entryMode', 'ageBucket', 'marketCapBucket', 'liquidityBucket', 'momentum5mBucket', 'momentum1mBucket', 'buyRatioBucket', 'concentrationBucket']) {
  const ranked = rankBuckets(dimensions[dimension]);
  if (ranked.length === 0) continue;
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  console.log(
    `${dimension}: best ${best[0]} (${best[1].trades} trades, ${fmtPct(best[1].winRate)}, avg ${fmtSol(best[1].avgPnlSol)}) | ` +
    `worst ${worst[0]} (${worst[1].trades} trades, ${fmtPct(worst[1].winRate)}, avg ${fmtSol(worst[1].avgPnlSol)})`
  );
}

if (recentRejects.length > 0) {
  console.log(`Recent non-trade records: ${recentRejects.map(evt => `${evt.symbol || evt.mint || 'unknown'}:${evt.reason}`).join(' | ')}`);
}
