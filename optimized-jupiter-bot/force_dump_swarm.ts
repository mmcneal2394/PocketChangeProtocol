import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

const JUP_HEADERS: Record<string, string> = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};

const keys = [
    process.env.PRIVATE_KEY_1,
    process.env.PRIVATE_KEY_2,
    process.env.PRIVATE_KEY_3,
    process.env.PRIVATE_KEY_4,
    process.env.PRIVATE_KEY_5,
    process.env.PRIVATE_KEY
].filter(Boolean) as string[];

const uniqueKeys = [...new Set(keys)];
const WSOL = 'So11111111111111111111111111111111111111112';

async function executeSwap(wallet: Keypair, inputMint: string, amount: string) {
    const qResp = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${WSOL}&amount=${amount}&slippageBps=10000`, { headers: JUP_HEADERS });
    const quote = await qResp.json();
    if (quote.error) {
        console.error(`Quote failed for ${inputMint}:`, quote.error);
        return;
    }
    const swapReq = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...JUP_HEADERS },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 1000000
        })
    });
    const swapRes = await swapReq.json();
    if (!swapRes.swapTransaction) {
         console.error(`Execution failed for ${inputMint}:`, swapRes);
         return;
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([wallet]);
    try {
        const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
        console.log(`✅ Forcibly Smashed Sell on ${inputMint} for ${wallet.publicKey.toBase58()}. Sig: https://solscan.io/tx/${sig}`);
    } catch(e) {
        console.error(`Send TX error:`, e);
    }
}

async function run() {
    console.log(`Scanning completely across all ${uniqueKeys.length} configured wallets for STUCK POSITIONS...`);
    const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    for (const key of uniqueKeys) {
        let wallet: Keypair;
        try {
            wallet = Keypair.fromSecretKey(bs58.decode(key));
        } catch { continue; }
        
        console.log(`Auditing Wallet: ${wallet.publicKey.toBase58()}`);
        for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
            const accts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: prog });
            for (const a of accts.value) {
                const info = a.account.data.parsed.info;
                if (info.tokenAmount.uiAmount > 0 && info.mint !== WSOL) {
                    console.log(`🚨 STALE TOKENS FOUND: ${info.tokenAmount.uiAmount} of ${info.mint}. NUKING IMMEDIATELY...`);
                    await executeSwap(wallet, info.mint, info.tokenAmount.amount);
                }
            }
        }
    }
    console.log("Global Swarm Diagnostic Dump Complete.");
}
run();
