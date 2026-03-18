import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const envConfig = fs.existsSync(envPath) ? require('dotenv').parse(fs.readFileSync(envPath)) : {};
    
    const privateKeyB58 = envConfig.SOLANA_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    const rpcUrl = envConfig.RPC_URL || process.env.RPC_URL || "https://beta.helius-rpc.com/?api-key=df082a16-aebf-4ec4-8ad6-86abfa06c8fc";
    let balance = 0.5; // fallback

    if (privateKeyB58 && privateKeyB58 !== "YOUR_NEW_PRIVATE_KEY_HERE" && privateKeyB58.length > 30) {
        const { Keypair, Connection } = require('@solana/web3.js');
        const bs58 = require('bs58');
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
        const connection = new Connection(rpcUrl, 'confirmed');
        // Simple unawaited fallback for speed in dashboard, but dynamic
        try {
            balance = await connection.getBalance(keypair.publicKey) / 1e9;
        } catch(e) {}
    }

    let dbPath = 'C:/tmp/engine-worker-clean/telemetry.jsonl';
    if (!fs.existsSync(dbPath)) {
        dbPath = path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl');
        if (!fs.existsSync(dbPath)) {
            dbPath = path.join(process.cwd(), 'telemetry.jsonl'); // Deep fallback
        }
    }

    let rawLogs: any[] = [];
    if (fs.existsSync(dbPath)) {
        try {
            const rawText = fs.readFileSync(dbPath, 'utf8').trim();
            // Parse JSON Lines file (each line is a complete JSON object)
            rawLogs = rawText.split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('{'))
                .map(line => JSON.parse(line));
        } catch(e) {
            console.error("Parse Error in Trades API:", e);
        }
    }

    const recentLogs = rawLogs.slice(-15).reverse();

    const formattedLogs = recentLogs.map((tx: any) => {
        const isSuccess = tx.status === 'EXEC_SUCCESS';
        // Engine prints true absolute SOL profit, no scaling required unless visualizing value
        const absoluteProfit = isSuccess ? parseFloat(tx.profit_sol || 0).toFixed(4) : "0.000";
        const shortHash = tx.tx_signature ? `${tx.tx_signature.substring(0, 5)}...${tx.tx_signature.substring(tx.tx_signature.length - 4)}` : "REJECTED";
        
        return {
            id: tx.tx_signature ? `${tx.tx_signature}_${tx.timestamp_sec}` : Math.random().toString(),
            route: tx.route || "UNKNOWN HOP",
            status: tx.status || "FAILED",
            profit: isSuccess ? `+${absoluteProfit} SOL` : `$0.00`,
            ok: isSuccess,
            hash: shortHash,
            details: `Latency: ${tx.execution_time_ms || '?'}ms | Tip: 2.5m lamports`
        };
    });

    return NextResponse.json(formattedLogs);

  } catch (error) {
    console.error("Trade API Error:", error);
    return NextResponse.json([]);
  }
}
