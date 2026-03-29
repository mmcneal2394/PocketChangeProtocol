import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const envPath = path.join(__dirname, '../.env');
  const envData = fs.readFileSync(envPath, 'utf8');
  let walletPath = '';
  let rpc = 'https://api.mainnet-beta.solana.com';
  let JUP_BASE = 'https://api.jup.ag/swap/v1';
  let JUP_KEY = '';
  
  for (const line of envData.split('\n')) {
    if (line.startsWith('WALLET_KEYPAIR_PATH=')) walletPath = line.split('=')[1].trim();
    if (line.startsWith('RPC_ENDPOINT=')) rpc = line.split('=')[1].trim();
    if (line.startsWith('JUPITER_ENDPOINT=')) JUP_BASE = line.split('=')[1].trim();
    if (line.startsWith('JUPITER_API_KEY=')) JUP_KEY = line.split('=')[1].trim();
  }
  
  if (walletPath.startsWith('./')) walletPath = walletPath.slice(2);
  const fullWalletPath = path.isAbsolute(walletPath) ? walletPath : path.join(__dirname, '..', walletPath);
  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(fullWalletPath, 'utf8')));
  const wallet = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(rpc, 'confirmed');
  
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';

  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  let usdcAmountStr = '0';
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.mint === USDC_MINT) { usdcAmountStr = info.tokenAmount.amount; }
  }
  
  if (usdcAmountStr === '0') { console.log('✅ No USDC found in wallet! Success!'); process.exit(0); }
  console.log(`🔄 Found ${Number(usdcAmountStr)/1e6} USDC remaining. Processing native fetch via ${JUP_BASE}...`);

  const headers: any = { 'Content-Type': 'application/json' };
  if (JUP_KEY) headers['x-api-key'] = JUP_KEY;

  // 1. Get Quote
  const quoteUrl = `${JUP_BASE}/quote?inputMint=${USDC_MINT}&outputMint=${WSOL_MINT}&amount=${usdcAmountStr}&slippageBps=500`;
  let req = await fetch(quoteUrl, { headers });
  if (!req.ok) { console.log(`Quote HTTP Error: ${req.status} ${req.statusText}`); const t = await req.text(); console.log(t); process.exit(1); }
  const quote = await req.json();
  if (quote.error || !quote.outAmount) { console.log('Quote Error Payload:', quote); process.exit(1); }
  console.log(`✅ Quote received! Expected Output: ${(Number(quote.outAmount)/1e9).toFixed(4)} WSOL`);
  
  // 2. Build Swap
  console.log(`Executing Swap Build... (200k fixed priority fee)`);
  const bodyPayload = JSON.stringify({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 200000 
  });
  
  req = await fetch(`${JUP_BASE}/swap`, { method: 'POST', headers, body: bodyPayload });
  if (!req.ok) { console.log(`Swap HTTP Error: ${req.status} ${req.statusText}`); const t = await req.text(); console.log(t); process.exit(1); }
  const swapData = await req.json();
  
  if (!swapData.swapTransaction) { console.log('Failed to fetch swapTransaction payload:', swapData); process.exit(1); }
  
  // 3. Send
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(txBuf);
  transaction.sign([wallet]);
  console.log(`🚀 Sending TX...`);
  
  const txHash = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 10 });
  console.log(`✅ TX Sent: ${txHash}`);
  
  // 4. Confirm it lands safely!
  console.log(`⏳ Waiting for block confirmation...`);
  const latestBlockHash = await connection.getLatestBlockhash();
  const conf = await connection.confirmTransaction({ blockhash: latestBlockHash.blockhash, lastValidBlockHeight: latestBlockHash.lastValidBlockHeight, signature: txHash });
  if (conf.value.err) { console.log(`❌ TX FAILED ON-CHAIN! ${JSON.stringify(conf.value.err)}`); process.exit(1); }
  console.log(`✅ confirmed: https://solscan.io/tx/${txHash}`);
}

main().catch(console.error);
