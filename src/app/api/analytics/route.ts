import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
    try {
        const dbPath = path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl');
        let logs: any[] = [];
        try {
            const fileContent = fs.readFileSync(dbPath, 'utf8');
            logs = fileContent.trim().split('\n').filter(line => line.length > 5).map(line => JSON.parse(line));
        } catch(e) {}
        
        let wins = 0;
        let sumProfit = 0;
        
        for (const log of logs) {
            if (log.success) {
                wins++;
                sumProfit += (log.profit_sol || 0);
            }
        }

        const totalTrades = logs.length;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
        const formattedPnL = sumProfit >= 0 ? `+$${sumProfit.toFixed(4)} USDC` : `-$${Math.abs(sumProfit).toFixed(4)} USDC`;
        
        return NextResponse.json({
            recentLogs: logs.slice(-20).reverse(),
            totalTrades,
            winRate: `${winRate}%`,
            totalPnL: formattedPnL,
            volume: `$${(totalTrades * 100).toFixed(2)} USDC`
        });
    } catch(e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
