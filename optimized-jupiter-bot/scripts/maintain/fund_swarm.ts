import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const ENV_PATH = path.resolve(process.cwd(), '.env');
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './wallet.json';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';

async function main() {
    console.log(`[FUNDING] 🚀 Initializing Swarm Fleet Creator...`);
    
    // 1. Load Master Wallet
    let attemptPath = process.env.WALLET_KEYPAIR_PATH || './wallet.json';
    if (!fs.existsSync(attemptPath)) {
        attemptPath = './wallet.json';
    }
    
    if (!fs.existsSync(attemptPath)) {
        console.error(`[FUNDING] ❌ Error: Master wallet not found at fallback ./wallet.json`);
        return;
    }
    const walletJson = JSON.parse(fs.readFileSync(attemptPath, 'utf-8'));
    const masterWallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
    console.log(`[FUNDING] 🏦 Master Funding Wallet (WALLET_1): ${masterWallet.publicKey.toBase58()}`);

    const connection = new Connection(RPC_ENDPOINT, { commitment: 'confirmed' });
    const balance = await connection.getBalance(masterWallet.publicKey);
    const balanceSol = balance / 1e9;
    console.log(`[FUNDING] 💰 Master Balance: ${balanceSol.toFixed(4)} SOL`);

    console.log(`[FUNDING] ⚠️ Skipping Live Network SOL transfer per Option 2 directive. Generating Base58 environment variables only.`);


    // 3. Generate Sub-Wallets
    const subWallets: Keypair[] = [];
    for (let i = 2; i <= 5; i++) {
        subWallets.push(Keypair.generate());
    }

    // 4. Execute Transfers (SKIPPED FOR OPTION 2 - CREATING ENV KEYS ONLY)
    console.log(`[FUNDING] 📡 Skipping Live Capital Transmittances. Preserving Master Bankroll.`);

    // 5. Update .env
    console.log(`[FUNDING] ⚙️ Synchronizing .env with new Base58 Private Keys...`);
    let envContent = '';
    if (fs.existsSync(ENV_PATH)) {
        envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    }

    // Prepare replacements
    const masterBase58 = bs58.encode(masterWallet.secretKey);
    const keysMap: Record<number, string> = {
        1: masterBase58,
        2: bs58.encode(subWallets[0].secretKey),
        3: bs58.encode(subWallets[1].secretKey),
        4: bs58.encode(subWallets[2].secretKey),
        5: bs58.encode(subWallets[3].secretKey),
    };

    // Inject keys into .env
    for (let i = 1; i <= 5; i++) {
        const keyRegex = new RegExp(`^PRIVATE_KEY_${i}=.*$`, 'm');
        const newStr = `PRIVATE_KEY_${i}=${keysMap[i]}`;
        
        if (envContent.match(keyRegex)) {
            envContent = envContent.replace(keyRegex, newStr);
        } else {
            // Append if not found
            envContent += `\n${newStr}`;
        }
    }

    fs.writeFileSync(ENV_PATH, envContent);
    console.log(`[FUNDING] 🎉 Swarm Multi-Wallet Configuration Complete! Check .env to verify.`);
    console.log(`\nSwarm Public Keys:`);
    console.log(`1. ${masterWallet.publicKey.toBase58()} (Master)`);
    for (let i = 0; i < subWallets.length; i++) {
        console.log(`${i+2}. ${subWallets[i].publicKey.toBase58()}`);
    }
}

main().catch(console.error);
