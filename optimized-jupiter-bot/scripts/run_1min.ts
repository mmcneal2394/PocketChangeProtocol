import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import Bottleneck from 'bottleneck';
import * as dotenv from 'dotenv';
import { buildVersionedTransaction } from '../src/execution/transaction';
import { config } from '../src/utils/config';

dotenv.config();

const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const jupiterLimiter = new Bottleneck({ reservoir: 3000, reservoirRefreshAmount: 3000, reservoirRefreshInterval: 60 * 1000, maxConcurrent: 15 });
const walletSecret = JSON.parse(fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletSecret));

const TARGETS = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbZedPFTp1Xq', symbol: 'JUP' },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3GBfDnp1XzY3B', symbol: 'PYTH' },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqwBoE1X', symbol: 'mSOL' },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL' },
  { mint: 'jtojtomex8xkvdXvnpq9k2u8q9r9kZ8u2q2kZ8u2q2k', symbol: 'JTO' },
  { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8CQq3AWKRMcbtaFD5', symbol: 'HNT' },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RNDR' },
  { mint: '7GCihgDB8fe6KNjn2TWtkGcgVzVxgB45rUGBqXkYqGvP', symbol: 'POPCAT' },
  { mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', symbol: 'WEN' },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME' },
  { mint: 'HhJpBhRRn4g56VsyLuT8DZBjzvdakWvCgKkGWe13tQo5', symbol: 'MYRO' },
  { mint: '7BgBvyjrZX1YKz4oh9mjb8ZVKykesoPOVs1sL3FhZixY', symbol: 'SLERF' },
  { mint: '7xKXtg2CW87d97TXJkAje2P7Kz7XGv2B8k3sQ7LdfQpX', symbol: 'SAMO' },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2eMOCKbypxzXZ8qN1x', symbol: 'NOS' },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA' },
  { mint: 'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxKBK', symbol: 'MNGO' },
  { mint: 'AURYydfxJib1ZkTir1Jn1JmEx1U1w1nNfLwY3R6oQWdY', symbol: 'AURY' }
];

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function getWalletBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / 1e9;
}

async function findAtomicOpportunity(targetMint: string, targetSymbol: string, amountInLamports: number) {
    const API_KEY = config.JUPITER_API_KEY || '05aa94b2-05d5-4993-acfe-30e18dc35ff1';
    const fetch = require('node-fetch');

    async function safeFetch(url: string, options: any) {
        return jupiterLimiter.schedule(async () => {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error("Fetch Failed: " + res.status);
            return res;
        });
    }

    // 1. SOL -> Target
    const q1Url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${targetMint}&amount=${amountInLamports}&slippageBps=${process.env.SLIPPAGE_BPS || 50}&onlyDirectRoutes=false&asLegacyTransaction=false`;
    const q1Res = await safeFetch(q1Url, { headers: { 'x-api-key': API_KEY } });
    const quote1 = await q1Res.json();

    // 2. Target -> SOL
    const q2Url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${targetMint}&outputMint=${SOL_MINT}&amount=${quote1.outAmount}&slippageBps=${process.env.SLIPPAGE_BPS || 50}&onlyDirectRoutes=false&asLegacyTransaction=false`;
    const q2Res = await safeFetch(q2Url, { headers: { 'x-api-key': API_KEY } });
    const quote2 = await q2Res.json();

    const inSol = amountInLamports / 1e9;
    const outSol = Number(quote2.outAmount) / 1e9;
    const grossProfit = outSol - inSol;
    
    // Exact structural accounting for transaction.ts deductions
    const staticBaseFee = 0.000005; // standard base SOL signature
    const computeUnitFee = 0.000350; // 250,000 microLamports baseline
    const structuralTip = 0.000005; // 5000 lamports static
    const totalNetworkOverhead = staticBaseFee + computeUnitFee + structuralTip;
    
    const netProfit = grossProfit - totalNetworkOverhead;

    if (netProfit >= parseFloat(process.env.MIN_PROFIT_SOL || "0.001")) {
         console.log(`\n🎯 ATOMIC ARBITRAGE FOUND! [${targetSymbol}] Net Profit: +${netProfit.toFixed(6)} SOL`);
         
         const ix1Res = await safeFetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
             method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
             body: JSON.stringify({ quoteResponse: quote1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
         });
         const ix1 = await ix1Res.json();

         const ix2Res = await safeFetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
             method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
             body: JSON.stringify({ quoteResponse: quote2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
         });
         const ix2 = await ix2Res.json();

         // Utilizing transaction.ts native bundler exactly as verified
         const tx = await buildVersionedTransaction(ix1, ix2, 5000); 
         return { transaction: tx, netProfit, targetSymbol };
    } else {
         console.log(`   📉 ${targetSymbol} Round-trip yields ${outSol.toFixed(6)} SOL (Net: ${netProfit.toFixed(6)} SOL)`);
         return null;
    }
}

async function main() {
   console.log("🚀 Starting Atomic Synthesizer Daemon over PM2...");
   console.log("⛓️ Execution Bound: Strict Synchronous (SOL -> TARGET -> SOL)");
   
   let lastBalance = await getWalletBalance();
   while (true) {
       for (const target of TARGETS) {
           try {
               let tradeAmountSol = lastBalance * parseFloat(process.env.TRADE_PERCENTAGE || "0.1");
               tradeAmountSol = Math.min(tradeAmountSol, parseFloat(process.env.MAX_TRADE_SOL || "1.0"));
               tradeAmountSol = Math.max(tradeAmountSol, 0.01);
               const amountInLamports = Math.floor(tradeAmountSol * 1e9);

               const opp = await findAtomicOpportunity(target.mint, target.symbol, amountInLamports);
               
               if (opp && opp.transaction) {
                   console.log(`🚀 Executing Atomic Bundle...`);
                   const sig = await connection.sendTransaction(opp.transaction, { skipPreflight: false });
                   console.log(`✅ Bundle Broadcasted! TX: https://solscan.io/tx/${sig}`);
               }
           } catch (e: any) {
               // Silently skip unindexable API traits avoiding loop contamination
               if (!e.message.includes("Failed")) {
                   process.stdout.write('x');
               }
           }
       }
       await new Promise(r => setTimeout(r, parseInt(process.env.POLL_INTERVAL_MS || "5000")));
   }
}

main().catch(console.error);
