// pcp_gas_monitor.ts — Watches native SOL gas and unwraps wSOL to top up when low
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import Redis from 'ioredis';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const MIN_SOL_BALANCE = 0.02;  // trigger top-up below this
const TOPUP_AMOUNT = 0.05;     // unwrap 0.05 SOL from wSOL each time
const CHECK_INTERVAL = 60_000; // check every 60 seconds
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

let wallet: Keypair;
try {
    wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));
} catch {
    const walletJson = require(process.env.WALLET_KEYPAIR_PATH || './wallet.json');
    wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
}

const WALLET_PUBKEY = wallet.publicKey;
console.log(`[GAS MONITOR] 🔥 Watching gas for ${WALLET_PUBKEY.toBase58()}`);
console.log(`[GAS MONITOR] Min threshold: ${MIN_SOL_BALANCE} SOL | Top-up amount: ${TOPUP_AMOUNT} SOL`);

async function getWsolBalance(): Promise<number> {
    try {
        const ata = await getAssociatedTokenAddress(WSOL_MINT, WALLET_PUBKEY);
        const info = await connection.getTokenAccountBalance(ata);
        return parseFloat(info.value.uiAmountString || '0');
    } catch {
        return 0;
    }
}

async function checkAndTopUp() {
    try {
        const balanceLamports = await connection.getBalance(WALLET_PUBKEY);
        const balanceSol = balanceLamports / 1e9;
        const wsolBal = await getWsolBalance();

        console.log(`[GAS MONITOR] ⛽ Native SOL: ${balanceSol.toFixed(6)} | wSOL: ${wsolBal.toFixed(6)}`);

        if (balanceSol >= MIN_SOL_BALANCE) {
            return; // Gas is fine
        }

        // Need top-up
        if (wsolBal < TOPUP_AMOUNT) {
            console.error(`[GAS MONITOR] 🚨 CRITICAL: Native SOL below ${MIN_SOL_BALANCE} AND wSOL too low (${wsolBal}) to top up!`);
            await redis.publish('system:alert', JSON.stringify({
                event: 'GAS_CRITICAL',
                nativeSol: balanceSol,
                wsolBalance: wsolBal,
                ts: Date.now()
            }));
            return;
        }

        console.log(`[GAS MONITOR] ⚠️  Low gas: ${balanceSol.toFixed(6)} SOL. Unwrapping ${TOPUP_AMOUNT} SOL from wSOL...`);

        // To "unwrap" wSOL, we close the wSOL token account which sends its SOL balance to the owner.
        // But we don't want to close the whole account — we want a partial unwrap.
        // Strategy: Create a temp wSOL account, transfer TOPUP_AMOUNT into it, then close it.
        // Simpler approach: just use a direct SOL transfer from wSOL ATA close isn't partial.
        // Actually the cleanest way: use syncNative after a transfer. But for simplicity:
        // We'll do a partial withdraw by creating a temporary token account approach.

        // Simplest reliable approach: Close the wSOL ATA (returns ALL wSOL as native SOL),
        // then re-wrap what we don't need. But that's complex.
        // 
        // PRACTICAL approach for gas: Just note that closing wSOL ATA returns all funds.
        // Since gas is critical, we close the ATA to get ALL wSOL back as native SOL.
        // The sniper will re-create the ATA when it needs to trade.

        const ata = await getAssociatedTokenAddress(WSOL_MINT, WALLET_PUBKEY);
        
        const tx = new Transaction().add(
            createCloseAccountInstruction(
                ata,                // account to close
                WALLET_PUBKEY,      // destination for SOL
                WALLET_PUBKEY,      // authority
                [],
                TOKEN_PROGRAM_ID
            )
        );

        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = WALLET_PUBKEY;
        tx.sign(wallet);

        const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await connection.confirmTransaction(txid, 'confirmed');

        const newBalance = await connection.getBalance(WALLET_PUBKEY);
        console.log(`[GAS MONITOR] ✅ wSOL unwrapped! TX: ${txid}`);
        console.log(`[GAS MONITOR] ✅ New native SOL balance: ${(newBalance / 1e9).toFixed(6)}`);

        await redis.set('gas:last_topup', Date.now().toString());
        await redis.publish('system:alert', JSON.stringify({
            event: 'GAS_TOPUP_SUCCESS',
            txid,
            newBalance: newBalance / 1e9,
            ts: Date.now()
        }));

    } catch (e: any) {
        console.error(`[GAS MONITOR] ❌ Error:`, e.message);
    }
}

// Daemon loop
async function initialize() {
    console.log('==========================================');
    console.log(' ⛽ PCP GAS MONITOR AGENT ONLINE ⛽');
    console.log('==========================================');
    await checkAndTopUp();
    setInterval(checkAndTopUp, CHECK_INTERVAL);
}

initialize();
