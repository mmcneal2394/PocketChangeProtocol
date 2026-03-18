import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
    try {
        const dbPath = path.join(process.cwd(), 'trades.json');
        let logs: any[] = [];
        try {
            logs = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        } catch(e) {}
        
        // Reverse array to put newest first
        logs.reverse();
        
        let wins = 0;
        let sumProfit = 0;
        
        for (const log of logs) {
            if (log.status && log.status.includes("SUCCESS")) {
                wins++;
                sumProfit += (log.profitAmt || 0);
            }
        }

        const totalTrades = logs.length;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
        const totalPnL = sumProfit.toFixed(4);
        
        return NextResponse.json({
            recentLogs: logs.slice(0, 20),
            totalTrades,
            winRate: `${winRate}%`,
            totalPnL: `${totalPnL} SOL`,
            volume: `${(totalTrades * 0.05).toFixed(2)} SOL`
        });
    } catch(e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
