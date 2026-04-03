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
    try {
        const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
        wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
    } catch (e) {
        wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));
    }
}

// ── 2. Volume Wash-Trading Engine ───────────────────────────────────────────

export async function executeWashTrade(mint: string, action: "buy" | "sell", amountSolOrPct: number | string) {
    console.log(`[WASH] 🌊 Spoofing ${action.toUpperCase()} for ${amountSolOrPct} on ${mint}...`);
    const isBuy = action === "buy";
    
    // Check if the user is trying to wash trade with more than they have
    if (isBuy && typeof amountSolOrPct === "number") {
         const bal = await connection.getBalance(wallet.publicKey);
         if (bal / 1e9 < amountSolOrPct + 0.005) {
              console.log(`[WASH] ⚠️ Insufficient SOL for wash buy. Requires: ${amountSolOrPct + 0.005}, Available: ${bal/1e9}`);
              return;
         }
    }

    try {
        const tradeResponse = await fetch("https://pumpportal.fun/api/trade-local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                publicKey: wallet.publicKey.toBase58(),
                action: action,     // "buy" or "sell"
                mint: mint,
                denominatedInSol: isBuy ? "true" : "false",
                amount: amountSolOrPct, 
                slippage: 20,       // Large slippage to guarantee execution on high volatility spoofing
                priorityFee: 0.0005, // Moderate priority fee
                pool: "pump"
            })
        });

        if (tradeResponse.status !== 200) {
            console.error(`[WASH] ❌ API fail: ${await tradeResponse.text()}`);
            return;
        }

        const txData = await tradeResponse.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
        tx.sign([wallet]);

        const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
        console.log(`[WASH] ✅ Wash ${action.toUpperCase()} Executed: https://solscan.io/tx/${sig}`);
        return sig;
    } catch (e: any) {
        console.error(`[WASH] ❌ Transaction sequence broken:`, e.message);
    }
}

export async function loopVolume(mint: string, cycles: number, baseTradeSol: number, pauseMs: number) {
    console.log(`[WASH] 🚀 Starting Volume Wash Routine for ${mint}`);
    console.log(`[WASH] 📊 Target: ${cycles} Buy/Sell Pairs | Volume/Cycle: ${(baseTradeSol*2).toFixed(3)} SOL`);

    for (let i = 0; i < cycles; i++) {
         console.log(`\n--- Cycle ${i+1}/${cycles} ---`);
         
         // 1. Buy
         await executeWashTrade(mint, "buy", baseTradeSol);
         
         console.log(`[WASH] ⏳ Waiting for Solana Validators to verify updated token balance...`);
         const jitterBuy = pauseMs + Math.floor(Math.random() * 2000) + 5000; // 5s padding
         await new Promise(r => setTimeout(r, jitterBuy));

         // 2. Sell (We sell 100% of the token bag we just acquired)
         await executeWashTrade(mint, "sell", "100%");
         
         const jitterSell = pauseMs + Math.floor(Math.random() * 2000);
         await new Promise(r => setTimeout(r, jitterSell));
    }
    
    console.log(`\n[WASH] 🏁 Volume Sweep Completed.`);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 4) {
        console.log("Usage: ts-node deployer_volume.ts <MintAddress> <Cycles> <TradeSOL> <DelayMs>");
        process.exit(1);
    }
    const [mint, c, s, d] = args;
    loopVolume(mint, parseInt(c), parseFloat(s), parseInt(d)).catch(console.error);
}
