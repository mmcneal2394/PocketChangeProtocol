const { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: __dirname + '/.env' });

async function main() {
    const rpcEndpoint = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcEndpoint, 'confirmed');
    
    // Read old wallet
    const walletPath = __dirname + '/' + process.env.WALLET_KEYPAIR_PATH.replace('./', '');
    const secretKeyStr = fs.readFileSync(walletPath, 'utf8');
    const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyStr));
    const oldWallet = Keypair.fromSecretKey(secretKeyArray);
    
    // Create new wallet
    const newWallet = Keypair.generate();
    fs.writeFileSync(__dirname + '/new_wallet.json', JSON.stringify(Array.from(newWallet.secretKey)));
    
    console.log(`[SECURE] New Wallet Public Key: ${newWallet.publicKey.toBase58()}`);
    console.log(`[SECURE] New wallet successfully isolated and saved to ./new_wallet.json`);
    
    const balance = await connection.getBalance(oldWallet.publicKey);
    console.log(`[SECURE] Origin Wallet Balance: ${balance / 1e9} SOL`);
    
    if (balance <= 50000) {
        console.log("[ERROR] Insufficient funds to sweep.");
        return;
    }
    
    // Leave 2,000,000 lamports (0.002 SOL) to ensure the Treasury remains completely Rent Exempt on Mainnet
    const sweepAmount = balance - 2000000;
    
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: oldWallet.publicKey,
            toPubkey: newWallet.publicKey,
            lamports: sweepAmount,
        })
    );
    
    console.log(`[SECURE] Executing native sweep of ${(sweepAmount / 1e9).toFixed(4)} SOL from Treasury (${oldWallet.publicKey.toBase58()}) to New Execution Wallet...`);
    const signature = await sendAndConfirmTransaction(connection, tx, [oldWallet], { commitment: 'confirmed' });
    console.log(`[VERIFIED] Sweep Execution Logged! Solana Mainnet Hash: https://solscan.io/tx/${signature}`);
}

main().catch(console.error);
