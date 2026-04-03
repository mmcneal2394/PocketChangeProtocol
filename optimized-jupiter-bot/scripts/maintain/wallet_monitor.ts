import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import Redis from 'ioredis';
import { config } from 'dotenv';

config();

const RPC_URL = (process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const WALLET_ADDRESSES = JSON.parse(process.env.ALPHA_WALLETS || '[]') as string[];

const redis = new Redis(REDIS_URL);
const connection = new Connection(RPC_URL, 'confirmed');

// Helper to normalize any address-like thing to base58 string
function toBase58(addr: PublicKey | string | any): string {
  if (addr instanceof PublicKey) return addr.toBase58();
  if (typeof addr === 'string') return addr;
  // If it's an object with a toBase58 method (e.g., from older libs)
  if (addr && typeof addr.toBase58 === 'function') return addr.toBase58();
  // Last resort: try to convert
  return new PublicKey(addr).toBase58();
}

async function monitorWallet(walletAddress: string) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    const balances: Record<string, number> = {};
    for (const account of tokenAccounts.value) {
      try {
        const parsedData = await connection.getParsedAccountInfo(account.pubkey);
        const data = parsedData.value?.data as any; // Cast as ANY to bypass solana web3 types
        if (data && data.parsed) {
            const info = data.parsed.info;
            if (info && info.tokenAmount && parseFloat(info.tokenAmount.amount) > 0) {
              const mint = info.mint;
              const amount = parseFloat(info.tokenAmount.uiAmount);
              balances[mint] = (balances[mint] || 0) + amount;
            }
        }
      } catch (innerErr) {
        console.error(`[MONITOR] Error parsing account ${account.pubkey.toBase58()}:`, innerErr);
      }
    }

    if (Object.keys(balances).length > 0) {
      await redis.publish('ALPHA_WALLET_UPDATE', JSON.stringify({
        wallet: walletAddress,
        balances,
        timestamp: Date.now()
      }));
      console.log(`[MONITOR] Published balances for ${walletAddress}`);
    }
  } catch (err) {
    console.error(`[MONITOR] Error monitoring wallet ${walletAddress}:`, err);
  }
}

async function mainLoop() {
  if (WALLET_ADDRESSES.length === 0) {
    console.warn('[MONITOR] No ALPHA_WALLETS defined in .env! Using failover legacy wallet boot.');
    // Failover
    try {
      const fs = require('fs');
      const bs58 = require('bs58');
      const kpString = process.env.PRIVATE_KEY_1 || fs.readFileSync('./wallet.json', 'utf8');
      import('@solana/web3.js').then(({ Keypair }) => {
        const kp = process.env.PRIVATE_KEY_1 
           ? Keypair.fromSecretKey(bs58.decode(kpString))
           : Keypair.fromSecretKey(new Uint8Array(JSON.parse(kpString)));
        WALLET_ADDRESSES.push(kp.publicKey.toBase58());
      });
    } catch(e) {}
  }

  console.log(`[MONITOR] Starting wallet monitor for ${WALLET_ADDRESSES.length} wallets`);
  while (true) {
    for (const wallet of WALLET_ADDRESSES) {
      if (wallet) await monitorWallet(wallet);
    }
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 sec interval
  }
}

mainLoop().catch(console.error);

// Heartbeat
setInterval(() => {
  redis.publish('HEARTBEAT', JSON.stringify({
    agent: 'wallet-monitor',
    status: 'alive',
    walletsTracked: WALLET_ADDRESSES.length
  }));
}, 10000);
