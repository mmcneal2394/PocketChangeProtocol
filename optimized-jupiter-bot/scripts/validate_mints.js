/**
 * Validate which token mints are live on Jupiter right now
 * Usage: node scripts/validate_mints.js
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');

const API_KEY = process.env.JUPITER_API_KEY || '';
const JUP = 'https://lite-api.jup.ag/swap/v1';
const SOL = 'So11111111111111111111111111111111111111112';
const TRADE = 10_000_000; // 0.01 SOL test

const TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'UXD',     mint: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT'  },
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'  },
  { symbol: 'stSOL',   mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y68Kk' },
  { symbol: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'ORCA',    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'  },
  { symbol: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'DRIFT',   mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7'  },
  { symbol: 'PYTH',    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'JTO',     mint: 'jtojtomepa8bdze8mswe2918ua3a9d9kiu3wbvtyj3bvb' },
  { symbol: 'ZEUS',    mint: 'ZEUS1aR7aX8pfnM3SWvqPBwkTnStnBzKF63fHFnmNio3' },
  { symbol: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MYRO',    mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
  { symbol: 'PONKE',   mint: '5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK31SR8sRL'  },
  { symbol: 'BOME',    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'   },
  { symbol: 'SLERF',   mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3'  },
  { symbol: 'ETH',     mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'  },
  { symbol: 'BTC',     mint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'  },
  { symbol: 'W',       mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ'  },
  { symbol: 'RNDR',    mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'   },
  { symbol: 'WEN',     mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'    },
];

async function check(token) {
  try {
    const r = await nodeFetch(`${JUP}/quote?inputMint=${SOL}&outputMint=${token.mint}&amount=${TRADE}&slippageBps=50`, {
      headers: { 'x-api-key': API_KEY }
    });
    const d = await r.json();
    if (d?.outAmount) return { ...token, ok: true, out: Number(d.outAmount), routeCount: d.routePlan?.length || 0 };
    return { ...token, ok: false, err: d?.error || 'no outAmount' };
  } catch(e) { return { ...token, ok: false, err: e.message.slice(0,60) }; }
}

async function main() {
  console.log('\nValidating', TOKENS.length, 'token mints against Jupiter...\n');
  const valid = [], invalid = [];
  for (const t of TOKENS) {
    process.stdout.write(`  ${t.symbol.padEnd(8)}`);
    const r = await check(t);
    if (r.ok) {
      valid.push(t);
      console.log(`✅  out:${r.out}  routes:${r.routeCount}`);
    } else {
      invalid.push(t);
      console.log(`❌  ${r.err}`);
    }
    await new Promise(r => setTimeout(r, 250)); // gentle rate-limit
  }
  console.log(`\n✅ VALID (${valid.length}): ${valid.map(t=>t.symbol).join(', ')}`);
  console.log(`❌ INVALID (${invalid.length}): ${invalid.map(t=>t.symbol).join(', ')}`);
}
main().catch(console.error);
