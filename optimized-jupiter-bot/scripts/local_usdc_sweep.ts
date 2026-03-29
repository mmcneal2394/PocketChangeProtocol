import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch'; // need node-fetch for v18/v20 compatibility sometimes if fetch missing
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const fullWalletPath = path.join(__dirname, '../local_wallet.json');
  if (!fs.existsSync(fullWalletPath)) {
      console.log('Wallet file removed/scrubbed.');
      process.exit(0);
  }
  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(fullWalletPath, 'utf8')));
  const wallet = Keypair.fromSecretKey(secretKey);
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';

  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  let usdcAmountStr = '0';
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.mint === USDC_MINT) { usdcAmountStr = info.tokenAmount.amount; }
  }
  
  if (usdcAmountStr === '0') { console.log('✅ No USDC found in wallet! Success!'); process.exit(0); }
  console.log(`🔄 Found ${Number(usdcAmountStr)/1e6} USDC remaining. Processing native fetch API via verified API key...`);

  // Setting the Enterprise Jupiter API Key from your .env
  const JUP_KEY = 'HIDDEN_KEY';
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': JUP_KEY };

  const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${WSOL_MINT}&amount=${usdcAmountStr}&slippageBps=1000`; // 10%
  let req = await fetch(quoteUrl, { headers });
  if (!req.ok) { console.log(`Quote HTTP Error: ${req.status} ${req.statusText}`); process.exit(1); }
  const quote = await req.json();
  if (quote.error || !quote.outAmount) { console.log('Quote Error Payload:', quote); process.exit(1); }
  console.log(`✅ Quote received! Expected Output: ${(Number(quote.outAmount)/1e9).toFixed(4)} WSOL`);
  
  console.log(`Executing Swap Build... (200k fixed priority fee)`);
  const bodyPayload = JSON.stringify({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 1500000 
  });
  
  req = await fetch(`https://api.jup.ag/swap/v1/swap`, { method: 'POST', headers, body: bodyPayload });
  if (!req.ok) { console.log(`Swap HTTP Error: ${req.status} ${req.statusText}`); process.exit(1); }
  const swapData = await req.json();
  
  if (!swapData.swapTransaction) { console.log('Failed to fetch swapTransaction payload:', swapData); process.exit(1); }
  
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(txBuf);
  transaction.sign([wallet]);
  console.log(`🚀 Sending TX...`);
  
  const txHash = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
  console.log(`✅ TX Sent: ${txHash}`);
  
  console.log(`⏳ Waiting for block confirmation...`);
  const latestBlockHash = await connection.getLatestBlockhash();
  const conf = await connection.confirmTransaction({ blockhash: latestBlockHash.blockhash, lastValidBlockHeight: latestBlockHash.lastValidBlockHeight, signature: txHash });
  if (conf.value.err) { console.log(`❌ TX FAILED ON-CHAIN! ${JSON.stringify(conf.value.err)}`); process.exit(1); }
  console.log(`✅ confirmed: https://solscan.io/tx/${txHash}`);

  // Scrub the key natively from the directory as requested:
  fs.unlinkSync(fullWalletPath);
  console.log('✅ local_wallet.json scrubbed securely.');
}

main().catch(console.error);
