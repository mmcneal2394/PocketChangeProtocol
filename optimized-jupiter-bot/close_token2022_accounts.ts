import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { createCloseAccountInstruction, createBurnInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

config();

const RPC = (process.env.RPC_ENDPOINT || '').trim();
const connection = new Connection(RPC, 'confirmed');

async function main() {
    const walletPath = process.env.WALLET_KEYPAIR_PATH || path.join(process.cwd(), 'wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

    console.log(`[CLOSE-2022] Wallet: ${wallet.publicKey.toBase58()}`);

    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
    });

    const emptyAccounts = accounts.value.filter(a => {
        return a.account.data.parsed.info.tokenAmount.uiAmount === 0;
    });

    const balanceAccounts = accounts.value.filter(a => {
        return a.account.data.parsed.info.tokenAmount.uiAmount > 0;
    });

    console.log(`[CLOSE-2022] Total: ${accounts.value.length} | Empty: ${emptyAccounts.length} | With balance: ${balanceAccounts.length}`);

    // Step 1: Burn dust balances then close those accounts
    if (balanceAccounts.length > 0) {
        console.log(`[CLOSE-2022] Burning ${balanceAccounts.length} dust token balances...`);
        const BATCH_SIZE = 3; // burn+close = 2 ix per account, keep tx small
        for (let i = 0; i < balanceAccounts.length; i += BATCH_SIZE) {
            const batch = balanceAccounts.slice(i, i + BATCH_SIZE);
            const tx = new Transaction();

            for (const acct of batch) {
                const info = acct.account.data.parsed.info;
                const mint = new PublicKey(info.mint);
                const acctPubkey = new PublicKey(acct.pubkey);
                const rawAmount = BigInt(info.tokenAmount.amount);

                if (rawAmount > 0n) {
                    tx.add(
                        createBurnInstruction(
                            acctPubkey,
                            mint,
                            wallet.publicKey,
                            rawAmount,
                            [],
                            TOKEN_2022_PROGRAM_ID,
                        )
                    );
                }
                tx.add(
                    createCloseAccountInstruction(
                        acctPubkey,
                        wallet.publicKey,
                        wallet.publicKey,
                        [],
                        TOKEN_2022_PROGRAM_ID,
                    )
                );
            }

            tx.feePayer = wallet.publicKey;
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.sign(wallet);

            try {
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
                console.log(`[CLOSE-2022] Burn+Close batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} accounts. Sig: ${sig}`);
                await connection.confirmTransaction(sig, 'confirmed');
                console.log(`[CLOSE-2022] ✅ Confirmed`);
            } catch (e: any) {
                console.error(`[CLOSE-2022] ⚠️ Burn batch failed: ${e.message?.slice(0, 200)}`);
            }
        }
    }

    // Step 2: Close all empty accounts in batches
    console.log(`[CLOSE-2022] Closing ${emptyAccounts.length} empty accounts...`);
    const CLOSE_BATCH = 10;
    let closed = 0;

    for (let i = 0; i < emptyAccounts.length; i += CLOSE_BATCH) {
        const batch = emptyAccounts.slice(i, i + CLOSE_BATCH);
        const tx = new Transaction();

        for (const acct of batch) {
            tx.add(
                createCloseAccountInstruction(
                    new PublicKey(acct.pubkey),
                    wallet.publicKey,
                    wallet.publicKey,
                    [],
                    TOKEN_2022_PROGRAM_ID,
                )
            );
        }

        tx.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(wallet);

        try {
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            closed += batch.length;
            console.log(`[CLOSE-2022] Batch ${Math.floor(i / CLOSE_BATCH) + 1}: Closed ${batch.length} (${closed}/${emptyAccounts.length}). Sig: ${sig}`);
            await connection.confirmTransaction(sig, 'confirmed');
        } catch (e: any) {
            console.error(`[CLOSE-2022] ⚠️ Close batch failed (will retry with smaller batch): ${e.message?.slice(0, 200)}`);
            // Retry one at a time for this batch
            for (const acct of batch) {
                try {
                    const soloTx = new Transaction();
                    soloTx.add(createCloseAccountInstruction(new PublicKey(acct.pubkey), wallet.publicKey, wallet.publicKey, [], TOKEN_2022_PROGRAM_ID));
                    soloTx.feePayer = wallet.publicKey;
                    const { blockhash: bh2 } = await connection.getLatestBlockhash('confirmed');
                    soloTx.recentBlockhash = bh2;
                    soloTx.sign(wallet);
                    const sig2 = await connection.sendRawTransaction(soloTx.serialize(), { skipPreflight: false });
                    await connection.confirmTransaction(sig2, 'confirmed');
                    closed++;
                    console.log(`[CLOSE-2022]   ✅ Solo closed ${acct.pubkey}`);
                } catch (e2: any) {
                    console.error(`[CLOSE-2022]   ❌ Failed: ${acct.pubkey} — ${e2.message?.slice(0, 100)}`);
                }
            }
        }
    }

    const rentReclaimed = (closed + balanceAccounts.length) * 0.00207408;
    console.log(`[CLOSE-2022] 🎉 Done! Closed ${closed + balanceAccounts.length} accounts. Reclaimed ~${rentReclaimed.toFixed(5)} SOL`);
}

main().catch(e => { console.error(e); process.exit(1); });
