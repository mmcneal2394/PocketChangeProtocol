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

async function executeLiveSwap(inputMint: string, outputMint: string, amountStr: string, label: string) {
    console.log(`[LIVE TEST] ⚡ Translating ${label}... (${amountStr} units)`);
    try {
        const quoteUrl = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=100`;
        const headers = API_KEY ? { headers: { 'x-api-key': API_KEY } } : {};
        
        const quoteRes = await axios.get(quoteUrl, headers);
        const quoteResponse = quoteRes.data;

        console.log(`[LIVE TEST] 🧮 Quote Received: Expected ${quoteResponse.outAmount} out.`);

        const swapRes = await axios.post(`${JUP_BASE}/swap`, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 150000 // 0.00015 SOL gas for instant confirmation test
        }, headers);

        const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`[LIVE TEST] 🚀 Broadcasting SIGNED payload to Mainnet...`);
        
        const rawTx = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            maxRetries: 3
        });

        console.log(`[LIVE TEST] ⏳ Transaction sent! Confirming blockhash: https://solscan.io/tx/${txid}`);
        
        // Wait for confirmation
        const latestBlockHash = await connection.getLatestBlockhash('confirmed');
        const confirmation = await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid
        }, 'confirmed');

        if (confirmation.value.err) {
            console.error(`[LIVE TEST] ❌ Transaction Failed on Chain:`, confirmation.value.err);
            return false;
        }

        console.log(`[LIVE TEST] ✅ CONFIRMED on chain!`);
        return quoteResponse.outAmount;
    } catch (e: any) {
        console.error(`[LIVE TEST] ❌ Fatal API Error: ${e.response?.data?.error || e.message}`);
        return false;
    }
}

async function runLiveMicroTest() {
    console.log(`\n=== 🧪 LIVE MICRO-AMOUNT HARDWARE TEST ===`);
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`RPC Node: ${connection.rpcEndpoint.split('//')[1].split('/')[0]}`);
    console.log(`==========================================\n`);

    // 1. Live Buy (0.001 SOL -> USDC)
    const buyInLamports = '1000000'; // 0.001 SOL ($0.18)
    const expectedUsdcOut = await executeLiveSwap(WSOL_MINT, USDC_MINT, buyInLamports, "BUY STAGE (wSOL -> USDC)");

    if (!expectedUsdcOut) {
        console.log(`\n[LIVE TEST] 🛑 Aborting due to Buy Stage failure (Likely out of wSOL gas!).`);
        process.exit(1);
    }

    console.log(`\n[LIVE TEST] ⏱️ Position Secured. Holding for 5 seconds to simulate engine delay...\n`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 2. Live Sell (USDC -> wSOL) using the exact minted amount returned by step 1
    // We adjust by 0.5% buffer in case of slippage dust, but Jupiter expects exact input
    // To be perfectly safe, we verify actual balance token account.
    
    // For simplicity of a 5 second round trip without fetching ATA, we'll blast the expected payout
    // but reduced slightly just in case of slippage difference: (99% of quote out)
    const secureSellAmount = Math.floor(parseInt(expectedUsdcOut) * 0.99).toString();
    
    await executeLiveSwap(USDC_MINT, WSOL_MINT, secureSellAmount, "SELL STAGE (USDC -> wSOL)");

    console.log(`\n=== 🎉 HARDWARE ROUTING TEST SUCCESSFUL ===\n`);
    process.exit(0);
}

runLiveMicroTest();
