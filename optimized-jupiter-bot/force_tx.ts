import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { config } from 'dotenv';
config();

// Standard payload mirroring PM2 bots
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY!;
const JUPITER_API = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const JUP_HEADERS: Record<string, string> = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};

const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const jupMint = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'; // RAY
const solMint = 'So11111111111111111111111111111111111111112';

async function executeLiveVerification() {
    console.log('⚡ Constructing physical test transaction (0.001 SOL -> RAY)...');
    
    // 1. Initialise connection
    const connection = new Connection(RPC_URL, 'confirmed');
    let wallet;
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    } catch {
        wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));
    }
    console.log(`[VERIFY] Executing physically over Wallet: ${wallet.publicKey.toBase58()}`);

    // 2. Fetch standard v1 Quote
    const amountInLamports = 1000000; // 0.001 SOL
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${solMint}&outputMint=${jupMint}&amount=${amountInLamports}&slippageBps=50`;
    console.log(`[VERIFY] Requesting Quote... (${jupMint})`);
    const quoteRes = await fetch(quoteUrl, { headers: JUP_HEADERS });
    const quote = await quoteRes.json();
    if (!quote || quote.error) {
        console.error('[VERIFY] Quote error:', quote);
        return;
    }

    // 3. Request Swap Instructions
    console.log(`[VERIFY] Deserializing Physical Swap Payload...`);
    const swapReq = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { ...JUP_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 100000, // Safe priority fee
        })
    });
    
    const swapData = await swapReq.json();
    if (!swapData.swapTransaction) {
        console.error('[VERIFY] Swap Payload Failed:', swapData);
        return;
    }

    // 4. Decode, Sign, and Dispatch
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([wallet]);

    console.log('[VERIFY] Broadcasting cleanly to Solana Mempool...');
    try {
        const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
        console.log(`[VERIFY] Mempool signature generated: ${signature}`);
        
        console.log(`[VERIFY] Waiting for network confirmation (can take up to 20s)...`);
        const confirm = await connection.confirmTransaction(signature, 'confirmed');
        if (confirm.value.err) throw new Error(JSON.stringify(confirm.value.err));
        
        console.log(`\n✅ Transaction Landed Successfully!`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${signature}`);
    } catch (e: any) {
        console.error("\n❌ Block Inclusion Failed:", e.message);
    }
}

executeLiveVerification();
