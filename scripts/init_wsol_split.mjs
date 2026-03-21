import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token';
import fs from 'fs';

async function initSplit() {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    const secretKeyStr = fs.readFileSync('/opt/pcprotocol/new_wallet.json', 'utf8');
    const executingWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyStr)));

    const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const bal = await connection.getBalance(executingWallet.publicKey);
    console.log(`Current Native SOL Balance: ${(bal / 1e9).toFixed(6)} SOL`);
    
    // We explicitly leave 0.05 SOL strictly for Gas Network Priority Base signatures
    const amountToWrap = bal - 50000000; 
    if (amountToWrap <= 0) {
        console.log("Not enough Native SOL to split securely while reserving 0.05 SOL physical base. Terminating.");
        return;
    }
    
    const ata = await getAssociatedTokenAddress(WSOL_MINT, executingWallet.publicKey);
    const instructions = [];
    
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
    
    const ataInfo = await connection.getAccountInfo(ata);
    if (!ataInfo) {
        console.log("Target WSOL SPL Account missing. Creating isolated container array natively...");
        instructions.push(createAssociatedTokenAccountInstruction(executingWallet.publicKey, ata, executingWallet.publicKey, WSOL_MINT));
    }
    
    console.log(`Wrapping ${(amountToWrap / 1e9).toFixed(5)} Native SOL directly into WSOL physical liquidity...`);
    instructions.push(SystemProgram.transfer({
        fromPubkey: executingWallet.publicKey,
        toPubkey: ata,
        lamports: amountToWrap
    }));
    instructions.push(createSyncNativeInstruction(ata));
    
    const latestBh = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
        payerKey: executingWallet.publicKey,
        recentBlockhash: latestBh.blockhash,
        instructions
    }).compileToV0Message();
    
    const tx = new VersionedTransaction(messageV0);
    tx.sign([executingWallet]);
    
    console.log("Transmitting Base Signature Protocol to Validators...");
    const txid = await connection.sendTransaction(tx);
    console.log(`✅ Base Split-Reserve TX Executed! Link: https://solscan.io/tx/${txid}`);

    // Sever event loop manually to return prompt control unconditionally
    process.exit(0);
}

initSplit();
