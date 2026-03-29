import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import RedisBus from '../../src/utils/redis_bus';
import { REDIS_KEYS } from '../../src/shared/redis_config';

dotenv.config();

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Load Master Wallet
let wallet: Keypair;
if (process.env.PRIVATE_KEY_1) {
    wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));
} else {
    const walletPath = process.env.WALLET_KEYPAIR_PATH || './wallet.json';
    const resolvedPath = fs.existsSync(walletPath) ? walletPath : './wallet.json';
    const walletJson = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_BASE = process.env.JUPITER_ENDPOINT || 'https://quote-api.jup.ag/v6';

async function executeSwap(inputMint: string, amountUi: number, decimals: number) {
    if (inputMint === WSOL_MINT || amountUi <= 0) return;

    const rawAmount = Math.floor(amountUi * Math.pow(10, decimals));
    const amountStr = rawAmount.toString();

    console.log(`[DUMP] ⚙️ Routing ${amountUi} ${inputMint.substring(0,8)}... to wSOL`);

    try {
        // 1. Get Quote
        const quoteUrl = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${WSOL_MINT}&amount=${amountStr}&slippageBps=300`;
        const quoteRes = await axios.get(quoteUrl, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });
        const quoteResponse = quoteRes.data;

        // 2. Build Transaction
        const swapUrl = `${JUP_BASE}/swap`;
        const swapRes = await axios.post(swapUrl, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 50000 // 0.00005 SOL priority fee for stable execution without exhausting reserves
        }, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });

        if (!swapRes.data || !swapRes.data.swapTransaction) {
            console.error(`[DUMP] ❌ Failed to assemble Jupiter swap structure for ${inputMint}`);
            return;
        }

        // 3. Deserialize & Sign
        const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        // 4. Broadcast
        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 3
        });
        
        console.log(`[DUMP] 📡 Broadcasted! Awaiting Confirmation...`);
        
        // Wait for confirmation
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        const confirmInfo = await connection.confirmTransaction({
            signature: txid,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
        }, 'confirmed');

        if (confirmInfo.value.err) {
            console.log(`[DUMP] ⚠️ Transaction Error on ${txid}:`, confirmInfo.value.err);
        } else {
            console.log(`[DUMP] ✅ Dumped Token: ${inputMint} | Sig: ${txid}`);
        }

    } catch (e: any) {
        console.error(`[DUMP] ❌ Routine Exception on ${inputMint}: ${e.response?.data?.error || e.message}`);
    }
}

async function dumpAll() {
    console.log(`[DUMP] 🚀 Booting Swarm Position Closer on ${wallet.publicKey.toBase58()}`);
    
    const pub = RedisBus.getPublisher();
    const currentStateRaw = await pub.get(REDIS_KEYS.WALLET_CURRENT);
    
    if (!currentStateRaw) {
        console.error(`[DUMP] ❌ Critical: No latest wallet state found natively in Redis. Please ensure pcp-wallet-monitor is running.`);
        return;
    }

    const state = JSON.parse(currentStateRaw);
    const numTokens = state.tokens.length;

    console.log(`[DUMP] 📊 Discovered ${numTokens} active tokens cached in state (Total Equity: $${state.totalValueUSD.toFixed(2)}).`);

    let processedCount = 0;
    for (const token of state.tokens) {
        if (token.mint === WSOL_MINT) continue;
        
        // Exclude tokens that don't have enough value (dust) or zero amount
        if (token.amount === 0 || token.valueUSD < 0.10) continue;

        console.log(`[DUMP] 📦 Found: ${token.mint} (Amt: ${token.amount} | Val: $${token.valueUSD.toFixed(3)})`);
        await executeSwap(token.mint, token.amount, token.decimals);
        processedCount++;
    }

    if (processedCount === 0) {
        console.log(`[DUMP] ℹ️ No sellable altcoins found in your active position list!`);
    } else {
        console.log(`[DUMP] 🎉 Portfolio consolidation pipeline complete!`);
    }

    process.exit(0);
}

dumpAll();
