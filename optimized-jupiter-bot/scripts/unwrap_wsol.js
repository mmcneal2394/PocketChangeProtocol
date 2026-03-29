const { Connection, Keypair, Transaction, sendAndConfirmTransaction, PublicKey } = require('@solana/web3.js');
const { createCloseAccountInstruction } = require('@solana/spl-token');
const fs = require('fs');

async function main() {
    console.log('--- REPLENISHING NATIVE GAS ---');
    const secretKey = new Uint8Array(JSON.parse(fs.readFileSync('./wallet.json', 'utf8')));
    const wallet = Keypair.fromSecretKey(secretKey);
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
    const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: wsolMint });
    
    if (accounts.value.length === 0) {
        console.log('No WSOL ATA found to unwrap.');
        return;
    }
    
    const wsolAta = accounts.value[0].pubkey;
    const balance = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmountString;
    console.log('Found WSOL ATA:', wsolAta.toBase58(), 'Balance:', balance);
    
    const tx = new Transaction().add(
        createCloseAccountInstruction(
            wsolAta,          // ATA to close
            wallet.publicKey, // Dest to receive the reclaimed SOL
            wallet.publicKey  // Owner of the ATA
        )
    );
    
    console.log('Sending transaction to Close WSOL Account...');
    try {
        const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
        console.log('✅ Unwrapped WSOL successfully! TX:', sig);
    } catch(e) {
        console.log('Failed:', e);
    }
}
main().catch(console.error);
