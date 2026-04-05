import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch'; // if needed, or native fetch
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY;
const connection = new Connection(RPC_URL, 'confirmed');

const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY!));
const WSOL = 'So11111111111111111111111111111111111111112';

async function executeSwap(inputMint: string, amount: string) {
    const qResp = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${WSOL}&amount=${amount}&slippageBps=5000`);
    const quote = await qResp.json();
    if (quote.error) {
        console.error(`Quote failed for ${inputMint}:`, quote.error);
        return;
    }
    const swapReq = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 500000 
        })
    });
    const swapRes = await swapReq.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    console.log(`Successfully forced sell ${inputMint}. Signature: https://solscan.io/tx/${sig}`);
}

async function run() {
    console.log(`Dumping all altcoins for wallet ${wallet.publicKey.toBase58()}...`);
    const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
        const accts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: prog });
        for (const a of accts.value) {
            const info = a.account.data.parsed.info;
            if (info.tokenAmount.uiAmount > 0 && info.mint !== WSOL) {
                console.log(`Found ${info.tokenAmount.uiAmount} of ${info.mint}. Selling...`);
                await executeSwap(info.mint, info.tokenAmount.amount);
            }
        }
    }
    console.log("Dump sequence completed.");
}
run();
