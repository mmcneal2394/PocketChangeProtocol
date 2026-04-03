import fs from 'fs';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, { commitment: 'confirmed' });

const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
let wallet: Keypair;
if (process.env.WALLET_INDEX && process.env[`PRIVATE_KEY_${process.env.WALLET_INDEX}`]) {
    wallet = Keypair.fromSecretKey(bs58.decode(process.env[`PRIVATE_KEY_${process.env.WALLET_INDEX}`]!));
} else {
    // Legacy fallback, don't crash if the path doesn't exist but we have ENV keys
    try {
        const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
        wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
    } catch (e) {
        console.warn(`[DEPLOYER] Could not parse WALLET_PATH. Attempting to fall back to PRIVATE_KEY_1...`);
        wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));
    }
}

// ── 1. Pump.fun Deployment Script ───────────────────────────────────────────

export async function deployToken(
    name: string,
    symbol: string,
    description: string,
    imagePath: string,
    initialBuySol: number
) {
    console.log(`[DEPLOYER] 🚀 Initiating Pump.fun deploy sequence for [${symbol}]...`);

    // 1. Generate new Mint Keypair
    const mintKeypair = Keypair.generate();
    console.log(`[DEPLOYER] 🪙 Generated Mint Address: ${mintKeypair.publicKey.toBase58()}`);

    // 2. Upload Metadata to IPFS via Pump.fun's native free endpoint
    console.log(`[DEPLOYER] 📡 Pushing Metadata to IPFS...`);
    const formData = new FormData();
    formData.append("name", name);
    formData.append("symbol", symbol);
    formData.append("description", description);
    formData.append("showName", "true");
    
    // Convert local file to Blob for FormData
    const imageBuffer = fs.readFileSync(imagePath);
    const blob = new Blob([imageBuffer], { type: 'image/png' });
    formData.append("file", blob, path.basename(imagePath));

    const initMetadataResponse = await fetch("https://pump.fun/api/ipfs", {
        method: "POST",
        body: formData,
    });
    
    const metadataResult = await initMetadataResponse.json();
    if (!metadataResult.metadataUri) {
         throw new Error(`Failed to upload IPFS metadata: ${JSON.stringify(metadataResult)}`);
    }
    console.log(`[DEPLOYER] ✅ Metadata secured at URI: ${metadataResult.metadataUri}`);

    // 3. Construct the Creation Transaction via PumpPortal API
    console.log(`[DEPLOYER] ⚙️ Building JITO-compatible Create + Initial Buy Transaction...`);
    const payload: any = {
        publicKey: wallet.publicKey.toBase58(),
        action: "create",
        mint: mintKeypair.publicKey.toBase58(),
        tokenMetadata: {
            name: name,
            symbol: symbol,
            uri: metadataResult.metadataUri
        },
        denominatedInSol: "true",
        amount: 0, // Sending amount 0 ensures the create TX builds successfully on PumpPortal.
        slippage: 10,           
        priorityFee: 0.0005,     
        pool: "pump"
    };

    const tradeResponse = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (tradeResponse.status !== 200) {
        throw new Error(`PumpPortal construction failed: ${await tradeResponse.text()}`);
    }

    // 4. Decode and Sign the Transaction
    const txData = await tradeResponse.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    
    // We must sign with BOTH the funding wallet AND the freshly generated Mint Keypair!
    tx.sign([mintKeypair, wallet]);

    console.log(`[DEPLOYER] 🔐 Transaction Signed. Broadcasting to Solana Network...`);
    
    // 5. Broadcast
    const signature = await connection.sendTransaction(tx, {
        skipPreflight: true, // required for pump.fun launch bundles
        maxRetries: 3
    });

    console.log(`[DEPLOYER] 💥 TOKEN LAUNCHED SUCCESSFULLY!`);
    console.log(`   └─ Signature: https://solscan.io/tx/${signature}`);
    console.log(`   └─ Pump.fun: https://pump.fun/${mintKeypair.publicKey.toBase58()}`);
    
    return {
         mint: mintKeypair.publicKey.toBase58(),
         signature
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 5) {
        console.log("Usage: ts-node deployer_engine.ts <Name> <Symbol> <Description> <ImagePath> <InitialBuySOL>");
        process.exit(1);
    }
    const [name, sym, desc, img, sol] = args;
    deployToken(name, sym, desc, img, parseFloat(sol)).catch(console.error);
}
