import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC = process.env.RPC_ENDPOINT!;
const connection = new Connection(RPC, { commitment: 'confirmed' });

const walletIndex = process.env.WALLET_INDEX;
let wallet: Keypair;

if (walletIndex && process.env[`PRIVATE_KEY_${walletIndex}`]) {
    const rawKey = process.env[`PRIVATE_KEY_${walletIndex}`]!;
    wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
} else {
    const walletPath = process.env.WALLET_KEYPAIR_PATH!;
    const walletJson = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
}

const WSOL = 'So11111111111111111111111111111111111111112';

async function main() {
    console.log(`[DUST-BURNER] 🔥 Scanning for orphaned ATA's and dust on ${wallet.publicKey.toBase58()}...`);
    
    // Fetch all token accounts
    const accts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
    
    const candidates = accts.value.filter(a => {
        const info = a.account.data.parsed.info;
        return info.mint !== WSOL; 
    });
    
    console.log(`[DUST-BURNER] 📊 Found ${candidates.length} sub-accounts to terminate!`);
    
    let totalRecouped = 0;
    
    // Process in batches of 5 to stay under transaction size limits
    const batchSize = 1; // Process 1 at a time to prevent single frozen tokens from tanking the whole batch
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const instructions = [];
        
        // Priority Fee for speed (0.0001 SOL)
        instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
        
        for (const { pubkey, account } of batch) {
            const info = account.data.parsed.info;
            const amountRaw = info.tokenAmount.amount;
            
            // If there's dust, add a burn instruction first
            if (amountRaw !== '0') {
                instructions.push(
                    createBurnInstruction(
                        pubkey, 
                        new PublicKey(info.mint), 
                        wallet.publicKey, 
                        BigInt(amountRaw)
                    )
                );
            }
            
            // Always close the account
            instructions.push(
                createCloseAccountInstruction(
                    pubkey,
                    wallet.publicKey, // Destination for the reclaimed 0.002 SOL rent
                    wallet.publicKey
                )
            );
        }
        
        try {
            const blockhash = await connection.getLatestBlockhash('confirmed');
            const message = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash.blockhash,
                instructions
            }).compileToV0Message();
            
            const tx = new VersionedTransaction(message);
            tx.sign([wallet]);
            
            // REMOVE skipPreflight to actually catch contract reverts!
            const sig = await connection.sendTransaction(tx, { skipPreflight: false });
            
            const count = batch.length;
            const recouped = count * 0.00203;
            totalRecouped += recouped;
            
            console.log(`[DUST-BURNER] 🧹 Reclaimed ~${recouped.toFixed(3)} SOL from ${count} accounts | Sig: ${sig}`);
            
            // Artificial delay to prevent aggressive RPC rate-limiting
            await new Promise(r => setTimeout(r, 1000));
        } catch (e: any) {
            console.error(`[DUST-BURNER] ⚠️ Batch fail: ${e.message}`);
        }
    }
    
    console.log(`[DUST-BURNER] ✅ Complete! Successfully reclaimed ~${totalRecouped.toFixed(3)} SOL back to principal.`);
}

main().catch(console.error);
