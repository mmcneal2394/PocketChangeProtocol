import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');
const wallet = new PublicKey('DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13');

async function run() {
    console.log(`\n--- ON-CHAIN BINARY AUDIT FOR ${wallet.toBase58()} ---`);
    const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const SOL_BAL = await connection.getBalance(wallet);
    console.log(`Native SOL: ${SOL_BAL / 1e9} SOL`);
    
    let tokensFound = 0;
    for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
        const accts = await connection.getParsedTokenAccountsByOwner(wallet, { programId: prog });
        for (const a of accts.value) {
            const info = a.account.data.parsed.info;
            if (info.tokenAmount.uiAmount > 0) {
                console.log(`Token Mint: ${info.mint} | Balance: ${info.tokenAmount.uiAmount}`);
                tokensFound++;
            }
        }
    }
    console.log(`Total active physical SPL Tokens held on Mainnet: ${tokensFound}`);
    console.log(`----------------------------------------------------\n`);
}
run();
