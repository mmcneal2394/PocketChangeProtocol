const { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } = require('@solana/web3.js');
const { createAssociatedTokenAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddress } = require('@solana/spl-token');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: __dirname + '/.env' });

async function main() {
    const connection = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
    
    const walletPath = __dirname + '/' + process.env.WALLET_KEYPAIR_PATH.replace('./', '');
    const secretKeyStr = fs.readFileSync(walletPath, 'utf8');
    const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyStr));
    const wallet = Keypair.fromSecretKey(secretKeyArray);
    
    console.log(`[WSOL] Authenticated Execution Key: ${wallet.publicKey.toBase58()}`);
    
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`[WSOL] Current Raw SOL Balance: ${(balance / 1e9).toFixed(4)} SOL`);
    
    // Target 95% of available balance to wrap, leaving native strictly for generic gas padding
    const wrapAmountLamports = Math.floor(balance * 0.95); 
    console.log(`[WSOL] Initiating structural Wrap of ${(wrapAmountLamports / 1e9).toFixed(4)} SOL into static WSOL...`);

    const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const ata = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);

    const tx = new Transaction();

    // Verify if ATA physically exists
    const accountInfo = await connection.getAccountInfo(ata);
    if (!accountInfo) {
        console.log(`[WSOL] Generating permanent WSOL Associated Token Account...`);
        tx.add(createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            ata,
            wallet.publicKey,
            WSOL_MINT
        ));
    }

    tx.add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: ata,
            lamports: wrapAmountLamports,
        }),
        createSyncNativeInstruction(ata)
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    console.log(`[VERIFIED] WSOL Capital structurally mapped! Signature: https://solscan.io/tx/${signature}`);
}

main().catch(console.error);
