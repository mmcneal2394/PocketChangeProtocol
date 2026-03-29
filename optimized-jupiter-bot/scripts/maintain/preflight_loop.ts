import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const connection = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_BASE = process.env.JUPITER_ENDPOINT || 'https://quote-api.jup.ag/v6';
const API_KEY = process.env.JUPITER_API_KEY || '';

async function simulateSwap(inputMint: string, outputMint: string, amountStr: string, label: string) {
    console.log(`[PREFLIGHT] ✈️  Initializing ${label} (${amountStr} lamports)`);
    try {
        const quoteUrl = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=50`;
        const headers = API_KEY ? { headers: { 'x-api-key': API_KEY } } : {};
        
        const quoteRes = await axios.get(quoteUrl, headers);
        const quoteResponse = quoteRes.data;

        console.log(`[PREFLIGHT] 🧮 Quote Received: ${quoteResponse.outAmount} expected out.`);

        const swapUrl = `${JUP_BASE}/swap`;
        const swapRes = await axios.post(swapUrl, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 10000 
        }, headers);

        const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`[PREFLIGHT] 🛡️ Validating Payload against Mainnet RPC (Dry Run)...`);
        
        const simResult = await connection.simulateTransaction(transaction, { commitment: 'confirmed' });
        
        if (simResult.value.err) {
            console.error(`[PREFLIGHT] ❌ Simulation Failed! Error:`, simResult.value.err);
            if (simResult.value.logs) {
                console.error(`[PREFLIGHT] 📄 Logs:\n`, simResult.value.logs.slice(-5).join("\n"));
            }
            return false;
        } else {
            console.log(`[PREFLIGHT] ✅ Simulation Passed! CU Consumed: ${simResult.value.unitsConsumed}`);
            return quoteResponse.outAmount; // Return output for the next leg of the loop
        }
    } catch (e: any) {
        console.error(`[PREFLIGHT] ❌ Fatal API Error: ${e.response?.data?.error || e.message}`);
        return false;
    }
}

async function runPreflight() {
    console.log(`\n=== 🚀 SWARM PREFLIGHT DIAGNOSTIC ===`);
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`RPC Node: ${connection.rpcEndpoint.split('//')[1].split('/')[0]}`);
    console.log(`======================================\n`);

    // 1. Dry Buy (0.005 SOL -> USDC)
    const buyInLamports = '5000000'; // 0.005 SOL
    const simulatedUsdcOut = await simulateSwap(WSOL_MINT, USDC_MINT, buyInLamports, "BUY STAGE (wSOL -> USDC)");

    if (!simulatedUsdcOut) {
        console.log(`\n[PREFLIGHT] 🛑 Aborting preflight loop due to Buy Stage failure.`);
        process.exit(1);
    }

    console.log(`\n[PREFLIGHT] ⏱️ Waiting 2 seconds to mimic position holding...\n`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Dry Sell (USDC -> wSOL)
    await simulateSwap(USDC_MINT, WSOL_MINT, simulatedUsdcOut, "SELL STAGE (USDC -> wSOL)");

    console.log(`\n=== 🎉 PREFLIGHT DRY LOOP COMPLETE ===\n`);
    process.exit(0);
}

runPreflight();
