import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import RedisBus from '../../src/utils/redis_bus';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
const connection = new Connection(RPC, { commitment: 'confirmed' });

const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
const walletPubkey = wallet.publicKey;

interface Position {
    mint: string;
    symbol: string;
    amount: number;
    valueUSD: number;
}

async function fetchTokenPrices(mints: string[]): Promise<Record<string, number>> {
    try {
        if (mints.length === 0) return {};
        
        // Use Jupiter V3 API patterned after existing sniper logic, leveraging API keys if available
        const ids = mints.join(',');
        const headers: any = {};
        if (process.env.JUPITER_API_KEY) {
            headers['x-api-key'] = process.env.JUPITER_API_KEY;
        }

        const url = `https://api.jup.ag/price/v3?ids=${ids}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        
        const prices: Record<string, number> = {};
        if (data) {
            for (const [mint, info] of Object.entries(data)) {
                if (info && (info as any).usdPrice) {
                    prices[mint] = parseFloat((info as any).usdPrice) || 0;
                }
            }
        }
        return prices;
    } catch (e: any) {
        console.error(`[MONITOR] Price fetch error: ${e.message}`);
        return {};
    }
}

async function scanWallet() {
    try {
        // 1. SOL Balance (Native Gas)
        const solBalanceLamports = await connection.getBalance(walletPubkey);
        const solBalance = solBalanceLamports / 1e9;

        // 3. Scan for other Altcoins/Spl-Tokens (and transient WSOL accounts)
        const [tokenAccounts, token2022Accounts] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(walletPubkey, {
                programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
            }),
            connection.getParsedTokenAccountsByOwner(walletPubkey, {
                programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
            })
        ]);

        const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];

        const tokens: { mint: string, amount: number }[] = [];
        
        // Aggregate all token accounts (including transient WSOL accounts)
        for (const account of allAccounts) {
            const parsed = account.account.data.parsed.info;
            const amount = parseFloat(parsed.tokenAmount.uiAmountString);
            if (amount > 0) {
                // If the array already has this mint, sum the amount (crucial for multiple WSOL accounts)
                const existing = tokens.find(t => t.mint === parsed.mint);
                if (existing) {
                    existing.amount += amount;
                } else {
                    tokens.push({ mint: parsed.mint, amount });
                }
            }
        }

        // Include SOL (WSOL wrapper pricing or SOL direct) for total value calculation
        const mintsToPricer = ['So11111111111111111111111111111111111111112', ...tokens.map(t => t.mint)];
        // Keep unique
        const uniqueMints = Array.from(new Set(mintsToPricer));

        // Chunk into 100s if necessary
        const prices = await fetchTokenPrices(uniqueMints);

        const positions: Position[] = [];
        // Native SOL is held exclusively for gas, so we omit it from Net Value tracking!
        const solPrice = prices['So11111111111111111111111111111111111111112'] || 0; // Removed fake 150 fallback
        
        let totalValueUSD = 0;

        for (const t of tokens) {
            // Ignore tiny dust
            if (t.amount < 0.000001) continue;

            let price = prices[t.mint];
            if (!price) {
                if (t.mint === 'So11111111111111111111111111111111111111112') price = solPrice;
                else price = 0;
            }

            const valueUSD = t.amount * price;
            totalValueUSD += valueUSD;

            positions.push({
                mint: t.mint,
                symbol: t.mint.slice(0, 6), // We'll mock symbol unless we pull metadata
                amount: t.amount,
                valueUSD
            });
        }

        const walletState = {
            timestamp: Date.now(),
            totalValueUSD,
            solBalance,
            positions
        };

        console.log(`[MONITOR] 💰 Trading Capital: $${totalValueUSD.toFixed(2)} | Gas: ${solBalance.toFixed(3)} SOL`);

        const p = RedisBus.getPublisher();
        // Set state for Critic to pull on demand
        await p.set('wallet:latest', JSON.stringify(walletState));
        
        // Dynamically append tracked tokens to the active:mints Redis set for the market daemon!
        if (uniqueMints.length > 0) {
            await p.sadd('active:mints', ...uniqueMints);
        }

        // Publish stream for Adjuster daemon
        await p.publish('wallet:state', JSON.stringify(walletState));
        // Publish Heartbeat
        await p.publish('heartbeat:agent', JSON.stringify({ agent: 'pcp-wallet-monitor', timestamp: Date.now() }));

    } catch (e: any) {
        console.error('[MONITOR] Scan error:', e.message);
    }
}

async function main() {
    console.log(`[MONITOR] 🛡️ Starting Capital Accumulation Monitor on ${walletPubkey.toBase58()}`);
    // Boot scan
    await scanWallet();
    // 30s interval
    setInterval(scanWallet, 30000);
}

main();
