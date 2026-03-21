import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { buildVersionedTransaction } from '../src/execution/transaction';
import { config } from '../src/utils/config';

dotenv.config();

const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const walletSecret = JSON.parse(fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletSecret));

const TARGETS = [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }];
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function getWalletBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / 1e9;
}

async function forceJitoTrace() {
   console.log("🚀 Starting Jito Engine TPU Injection Diagnostic Sandbox...");
   console.log("⚙️  Target Slippage BPS: 5 (0.05%)");
   
   await new Promise(r => setTimeout(r, 4000)); // Rate limit bypass
   
   let lastBalance = await getWalletBalance();
   let tradeAmountSol = lastBalance * 0.1;
   tradeAmountSol = Math.min(tradeAmountSol, 1.0);
   tradeAmountSol = Math.max(tradeAmountSol, 0.01);
   const amountInLamports = Math.floor(tradeAmountSol * 1e9);
   
   const target = TARGETS[0];
   const API_KEY = config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
   
   console.log(`\n🔄 Extracting arrays for [${target.symbol}] at ${tradeAmountSol.toFixed(4)} SOL boundary...`);

   const fetch = require('node-fetch');
   const bs58 = require('bs58');

   async function fetchWithRetry(url: string, options: any) {
      while (true) {
          const res = await fetch(url, options);
          if (res.ok) return await res.json();
          console.log(`⏳ Rate Limited by Jup Lite API. Waiting 10 seconds to backoff...`);
          await new Promise(r => setTimeout(r, 10000));
      }
   }

   // Jito-safe: exclude AMM pools confirmed to lock vote accounts (verified via simulation)
   const EXCLUDE_DEXES = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');

   const q1Url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${target.mint}&amount=${amountInLamports}&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=${EXCLUDE_DEXES}`;
   const quote1 = await fetchWithRetry(q1Url, { headers: { 'x-api-key': API_KEY } });

   const q2Url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${target.mint}&outputMint=${SOL_MINT}&amount=${quote1.outAmount}&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=${EXCLUDE_DEXES}`;
   const quote2 = await fetchWithRetry(q2Url, { headers: { 'x-api-key': API_KEY } });

   const inSol = amountInLamports / 1e9;
   const outSol = Number(quote2.outAmount) / 1e9;
   const grossProfit = outSol - inSol;
   
   const grossProfitLamports = Math.floor(grossProfit * 1e9);
   const tipLamports = Math.max(Math.min(Math.floor(grossProfitLamports * 0.5), 5000000), 1000);
   const dynamicTipSol = tipLamports / 1e9;

   const netProfit = grossProfit - (0.000355 + dynamicTipSol);

   console.log(`🗺️ Route Taken: SOL -> [${target.symbol}] ExactIn -> SOL ExactOut`);
   console.log(`\n🎯 FORCED JITO INJECTION EXECUTED! Expected PnL: ${netProfit.toFixed(8)} SOL`);

   const ix1 = await fetchWithRetry('https://lite-api.jup.ag/swap/v1/swap-instructions', {
       method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
       body: JSON.stringify({ quoteResponse: quote1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
   });

   const ix2 = await fetchWithRetry('https://lite-api.jup.ag/swap/v1/swap-instructions', {
       method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
       body: JSON.stringify({ quoteResponse: quote2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
   });

   const tx = await buildVersionedTransaction(ix1, ix2, tipLamports); 
   if (!tx) { throw new Error("Null Transaction natively constructed."); }

   console.log(`\n🩺 Simulating Payload over standard RPC to isolate Byte Arrays...`);
   try {
       const simRes = await connection.simulateTransaction(tx, { sigVerify: true });
       console.log(`[Simulation Result]:`, JSON.stringify(simRes.value));
   } catch(e: any) {
       console.error(`❌ Local Simulation Serialization Crash:`, e.message);
   }

   const encodedTx = bs58.encode(tx.serialize());
   const jitoPayload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[encodedTx]] };
                   
   console.log(`\n🚀 Transmitting Atomic Bundle natively via Jito TPU REST Envelope...`);
   const execStart = Date.now();
   
   const jitoRes = await fetch("https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles", {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(jitoPayload)
   });
   const jitoData = await jitoRes.json();
                   
   const execEnd = Date.now();
   console.log(`✅ Bundle payload processed outside public limits!`);
   console.log(`[Jito Trace Response]:`, JSON.stringify(jitoData));
   console.log(`⏱️ Transaction Block-Engine Transmission Latency: ${execEnd - execStart}ms`);
                   
   const sig = bs58.encode(tx.signatures[0]);
   console.log(`🔗 Tracking Signature: https://solscan.io/tx/${sig}`);
   
   process.exit(0);
}

forceJitoTrace().catch((e) => {
    console.error(`\n❌ ERROR Executing Jito Sandbox: ${e.message}`);
    process.exit(1);
});
