/**
 * price_stream_test.ts  —  Live price feed verification (run anytime)
 * Usage: npx ts-node scripts/price_stream_test.ts
 *
 * Prints a live table every 5s showing all monitored pairs + source + age.
 * Ctrl-C to stop.
 */
import dotenv from 'dotenv';
dotenv.config();

import { priceFeed, MONITORED_MINTS } from '../src/utils/price_feed';

const SYMBOL: Record<string, string> = {
  'So11111111111111111111111111111111111111112':   'SOL/USD',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC/USD',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':  'USDT/USD',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  'MSOL/USD',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':  'jitoSOL/USD',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':   'bSOL/USD',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE':   'ORCA/USD',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  'RAY/USD',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':  'BONK/USD',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo':  'WIF/USD',
  '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p':  'POPCAT/USD',
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT':   'BOME/USD',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN':  'TRUMP/USD',
  'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P':  'MELANIA/USD',
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump':  'FARTCOIN/USD',
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC':  'AI16Z/USD',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK':    'JUP/USD',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':   'JTO/USD',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4':  'MEW/USD',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh':  'PYTH/USD',
};

function printTable() {
  const snap = priceFeed.snapshot();
  const rows = MONITORED_MINTS.map(mint => {
    const entry  = snap[mint];
    const sym    = SYMBOL[mint] || mint.slice(0, 8);
    if (!entry) return `  ${sym.padEnd(14)} ${'--'.padStart(14)}  [waiting...]`;
    const price  = entry.price;
    const age    = entry.ageMs;
    const srcTag = age < 2000 ? '⚡Pyth' : age < 10_000 ? '🌐Jup' : '⚠️STALE';
    const fmt    = price < 0.00001 ? price.toExponential(4)
                 : price < 0.01    ? price.toFixed(8)
                 : price < 1       ? price.toFixed(6)
                 : price.toFixed(4);
    const ms = age < 60_000 ? `${age.toFixed(0)}ms ago` : `${(age/1000).toFixed(0)}s ago`;
    return `  ${sym.padEnd(14)} $${fmt.padStart(14)}  ${srcTag}  ${ms}`;
  });

  console.clear();
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║   PCP Live Price Stream   ${new Date().toTimeString().slice(0,8)}                      ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Pair           Price           Source     Last update        ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  for (const row of rows) console.log(`║${row.padEnd(63)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  console.log(`  SOL:  $${priceFeed.getSolPrice().toFixed(4)}   |  Press Ctrl-C to stop`);
}

// Subscribe to first-price events for snappy initial display
priceFeed.on('price', () => { /* triggers table repaint below */ });

console.log('🚀 Starting live price feed... (first update via Jupiter ~2s, Pyth on-chain immediately)\n');
priceFeed.start();

// Repaint every second
setInterval(printTable, 1000);
printTable();

process.on('SIGINT', async () => {
  await priceFeed.stop();
  process.exit(0);
});
