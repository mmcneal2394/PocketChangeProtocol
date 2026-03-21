require('dotenv').config();
const nodeFetch = require('node-fetch');
const bs58      = require('bs58');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT;
const JUP_KEY   = process.env.JUPITER_API_KEY;
const JUP_BASE  = 'https://api.jup.ag/swap/v1';
const wSOL      = 'So11111111111111111111111111111111111111112';
const USDC      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_BPS   = parseInt(process.env.PLATFORM_FEE_BPS);
const FEE_USDC  = process.env.PLATFORM_FEE_ACCOUNT_USDC;
const JUP_H     = { 'Content-Type':'application/json','x-api-key':JUP_KEY };

const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const conn   = new Connection(HELIUS_RPC, 'confirmed');

async function main() {
  // 1. Quote with fee
  const qUrl = `${JUP_BASE}/quote?inputMint=${wSOL}&outputMint=${USDC}&amount=20000000&slippageBps=100&platformFeeBps=${FEE_BPS}`;
  console.log('Quoting:', qUrl);
  const qr = await nodeFetch(qUrl, { headers: JUP_H });
  const q  = await qr.json();
  console.log('Quote status:', qr.status);
  console.log('Quote outAmount:', q.outAmount);
  console.log('Quote platformFee:', JSON.stringify(q.platformFee));

  // 2. Swap
  const swapBody = { quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: false, feeAccount: FEE_USDC, computeUnitPriceMicroLamports: 150000, dynamicComputeUnitLimit: true };
  console.log('\nSwap feeAccount:', FEE_USDC);
  const sr = await nodeFetch(`${JUP_BASE}/swap`, { method:'POST', headers:JUP_H, body:JSON.stringify(swapBody) });
  const sj = await sr.json();
  console.log('Swap status:', sr.status);
  if (sj.error) { console.log('Swap error:', sj.error, sj.errorCode); return; }
  const txStr = sj.swapTransaction;
  console.log('Tx type:', typeof txStr, 'length:', txStr?.length);
  console.log('Tx first 20 chars:', txStr?.slice(0,20));

  // 3. Check if it's base58 decodable 
  try { bs58.decode(txStr); console.log('✅ base58 decode OK'); }
  catch(e) { console.log('❌ base58 fail:', e.message);
    // Try base64 instead
    try { const buf = Buffer.from(txStr, 'base64'); console.log('✅ base64 decode OK, length:', buf.length);
      const tx = VersionedTransaction.deserialize(buf); tx.sign([wallet]);
      const raw = tx.serialize();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight:true, maxRetries:3 });
      console.log('✅ Sent! sig:', sig, '\nhttps://solscan.io/tx/'+sig);
    } catch(e2) { console.log('❌ base64 also fail:', e2.message); }
  }
}
main().catch(e => console.error('FATAL:', e.message));
