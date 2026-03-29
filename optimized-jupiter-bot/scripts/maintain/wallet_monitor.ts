import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import RedisBus from '../../src/utils/redis_bus';
import { REDIS_KEYS, CHANNELS } from '../../src/shared/redis_config';

dotenv.config();

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Boot strictly the Master Funding Wallet
let walletPubkey: PublicKey;
if (process.env.PRIVATE_KEY_1) {
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));
    walletPubkey = kp.publicKey;
} else {
    // Legacy mapping
    const walletPath = process.env.WALLET_KEYPAIR_PATH || './wallet.json';
    const resolvedPath = fs.existsSync(walletPath) ? walletPath : './wallet.json';
    const walletJson = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    const kp = Keypair.fromSecretKey(new Uint8Array(walletJson));
    walletPubkey = kp.publicKey;
}

console.log(`[MONITOR] 🔭 Tracking Total Swarm Equity on Master Wallet: ${walletPubkey.toBase58()}`);

async function getAllTokenBalances() {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );
    
    const token2022Accounts = await connection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }
    );

    const mergedAccounts = [...tokenAccounts.value, ...token2022Accounts.value];

    const balances = [];
    for (const account of mergedAccounts) {
        const parsed = account.account.data.parsed;
        if (parsed?.info?.tokenAmount?.uiAmount > 0) {
            balances.push({
                mint: parsed.info.mint,
                amount: parsed.info.tokenAmount.uiAmount,
                decimals: parsed.info.tokenAmount.decimals,
            });
        }
    }
    return balances;
}

async function monitorWallet() {
    try {
        const pub = RedisBus.getPublisher();

        // 1. Native SOL balance
        const solBalanceLamports = await connection.getBalance(walletPubkey);
        const solBalance = solBalanceLamports / 1e9;
        
        // Tracking outbound RPC usage natively
        await pub.incrby('rpc:calls:total', 3); // 1 balance + 2 getParsedTokenAccountsByOwner

        // 2. All SPL token balances (including wSOL)
        const tokenBalances = await getAllTokenBalances();

        // 3. Collect unique mint addresses for price lookup
        const mints = tokenBalances.map(t => t.mint);
        if (solBalance > 0) mints.push('So11111111111111111111111111111111111111112'); // wSOL mint for exact price pricing

        // 4. Fetch prices from Jupiter
        let prices: Record<string, any> = {};
        if (mints.length > 0) {
            // deduplicate mints list
            const uniqueMints = Array.from(new Set(mints));
            const ids = uniqueMints.join(',');
            // Jup v3 price expects max 100 ids typically but our wallet usually has << 100
            const response = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, {
                headers: { 'x-api-key': process.env.JUPITER_API_KEY || '' }
            });
            const data = await response.json();
            if (data) {
                prices = data.data || data;
            }
        }

        // 5. Compute total USD value
        let totalValueUSD = 0;

        // Native SOL: price from wSOL mint
        const wsolId = 'So11111111111111111111111111111111111111112';
        const solPrice = prices[wsolId]?.price || prices[wsolId]?.usdPrice || parseFloat(await pub.hget(`price:${wsolId}`, 'usd') || '0');
        totalValueUSD += solBalance * solPrice;

        // Token balances
        const enrichedBalances = tokenBalances.map(token => {
            const price = prices[token.mint]?.price || prices[token.mint]?.usdPrice || 0;
            const valueUSD = token.amount * price;
            totalValueUSD += valueUSD;
            return { ...token, price, valueUSD };
        });

        // 6. Prepare wallet state
        const walletState = {
            timestamp: Date.now(),
            solBalance,
            solPrice,
            totalValueUSD,
            tokens: enrichedBalances,
        };

        // 7. Store in Redis (persistent strings)
        await pub.set(REDIS_KEYS.WALLET_CURRENT, JSON.stringify(walletState));
        await pub.set(REDIS_KEYS.WALLET_TOTAL_USD, totalValueUSD.toString());

        // 8. Publish to channel for real-time updates
        await pub.publish(CHANNELS.WALLET_STATE, JSON.stringify(walletState));

        console.log(`[MONITOR] 💰 Total Swarm Equity: $${totalValueUSD.toFixed(2)} (SOL: ${solBalance.toFixed(4)}, Sub-Tokens: ${enrichedBalances.length})`);
    } catch (error: any) {
        console.error('[MONITOR] ❌ Wallet monitor generic loop error:', error.message);
    }
}

async function startDaemon() {
    console.log('[MONITOR] 🚀 Booting Comprehensive Swarm Wallet Metrics Daemon... (Rate Limited)');
    await monitorWallet();
    setInterval(monitorWallet, 120_000); 
}

startDaemon();
