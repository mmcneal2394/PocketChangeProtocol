import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

config();

const RPC = (process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com').trim();
const connection = new Connection(RPC, 'confirmed');

async function main() {
    const walletPath = process.env.WALLET_KEYPAIR_PATH || path.join(process.cwd(), 'wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

    console.log(`[CLOSE] Wallet: ${wallet.publicKey.toBase58()}`);

    // Fetch all token accounts
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
    });

    const emptyAccounts = accounts.value.filter(a => {
        const amount = a.account.data.parsed.info.tokenAmount.uiAmount;
        return amount === 0;
    });

    console.log(`[CLOSE] Found ${emptyAccounts.length} empty token accounts to close`);

    if (emptyAccounts.length === 0) {
        console.log('[CLOSE] Nothing to close.');
        return;
    }

    // Close in batches of 5 to avoid tx size limits
    const BATCH_SIZE = 5;
    for (let i = 0; i < emptyAccounts.length; i += BATCH_SIZE) {
        const batch = emptyAccounts.slice(i, i + BATCH_SIZE);
        const tx = new Transaction();

        for (const acct of batch) {
            tx.add(
                createCloseAccountInstruction(
                    new PublicKey(acct.pubkey),
                    wallet.publicKey,  // destination for rent SOL
                    wallet.publicKey,  // authority
                    [],
                    TOKEN_PROGRAM_ID,
                )
            );
        }

        tx.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(wallet);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        console.log(`[CLOSE] Batch ${Math.floor(i / BATCH_SIZE) + 1}: Closed ${batch.length} accounts. Sig: ${sig}`);
        
        // Wait for confirmation
        await connection.confirmTransaction(sig, 'confirmed');
        console.log(`[CLOSE] ✅ Confirmed`);
    }

    const rentReclaimed = emptyAccounts.length * 0.00204;
    console.log(`[CLOSE] 🎉 Done! Reclaimed ~${rentReclaimed.toFixed(5)} SOL from ${emptyAccounts.length} accounts`);
}

main().catch(e => { console.error(e); process.exit(1); });
