import { createJupiterApiClient } from '@jup-ag/api';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const envPath = path.join(__dirname, '../.env');
  const envData = fs.readFileSync(envPath, 'utf8');
  let walletPath = '';
  let rpc = 'https://api.mainnet-beta.solana.com';
  let jupEndpoint = 'https://api.jup.ag/swap/v1';
  
  for (const line of envData.split('\n')) {
    if (line.startsWith('WALLET_KEYPAIR_PATH=')) walletPath = line.split('=')[1].trim();
    if (line.startsWith('RPC_ENDPOINT=')) rpc = line.split('=')[1].trim();
    if (line.startsWith('JUPITER_ENDPOINT=')) jupEndpoint = line.split('=')[1].trim();
  }
  
  if (walletPath.startsWith('./')) walletPath = walletPath.slice(2);
  const fullWalletPath = path.isAbsolute(walletPath) ? walletPath : path.join(__dirname, '..', walletPath);
  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(fullWalletPath, 'utf8')));
  const wallet = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(rpc, 'confirmed');
  
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  let usdcAmountStr = '0';
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.mint === USDC_MINT) { usdcAmountStr = info.tokenAmount.amount; }
  }
  
  if (usdcAmountStr === '0') {
      console.log('❌ No USDC found in wallet.');
      process.exit(1);
  }
  
  console.log(`🔄 Found ${Number(usdcAmountStr)/1e6} USDC. Requesting Jupiter Quote to Swap to WSOL...`);
  
  const jupiter = createJupiterApiClient({ basePath: jupEndpoint });
  const quoteResponse = await jupiter.quoteGet({
    inputMint: USDC_MINT,
    outputMint: WSOL_MINT,
    amount: Number(usdcAmountStr),
    slippageBps: 200, // 2%
  });
  
  if (!quoteResponse) {
      console.log('❌ Failed to get quote from Jupiter.');
      process.exit(1);
  }
  
  console.log(`✅ Quote received! Expected Output: ${(Number(quoteResponse.outAmount)/1e9).toFixed(4)} WSOL`);
  
  console.log("Building Transaction Payload...");
  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true
    }
  });
  
  if (!swapTransaction) {
      console.log('❌ Failed to construct swap transaction.');
      process.exit(1);
  }
  
  const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);
  
  console.log('🚀 Submitting Transaction to Solana Network...');
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });
  
  console.log(`✅ SUCCESS! Transaction Sent!`);
  console.log(`🔗 https://solscan.io/tx/${signature}`);
}

main().catch(console.error);
