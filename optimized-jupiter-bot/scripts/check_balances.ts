import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const envPath = path.join(__dirname, '../.env');
  const envData = fs.readFileSync(envPath, 'utf8');
  let walletPath = '';
  for (const line of envData.split('\n')) {
    if (line.startsWith('WALLET_KEYPAIR_PATH=')) {
      walletPath = line.split('=')[1].trim();
      break;
    }
  }
  
  if (walletPath.startsWith('./')) {
      walletPath = walletPath.slice(2);
  }
  const fullWalletPath = path.isAbsolute(walletPath) ? walletPath : path.join(__dirname, '..', walletPath);
  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(fullWalletPath, 'utf8')));
  const wallet = Keypair.fromSecretKey(secretKey);
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  
  const solBalance = await connection.getBalance(wallet.publicKey);
  console.log('--- PREFLIGHT CHECK ---');
  console.log('Wallet: ' + wallet.publicKey.toBase58());
  console.log('SOL Balance:  ' + (solBalance / 1e9).toFixed(4) + ' SOL');

  const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  
  let wsolBalance = 0;
  let usdcBalance = 0;
  
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.mint === WSOL_MINT.toBase58()) wsolBalance = info.tokenAmount.uiAmount || 0;
    if (info.mint === USDC_MINT.toBase58()) usdcBalance = info.tokenAmount.uiAmount || 0;
  }
  
  console.log('WSOL Balance: ' + wsolBalance.toFixed(4) + ' WSOL');
  console.log('USDC Balance: ' + usdcBalance.toFixed(2) + ' USDC');
}
main().catch(console.error);
