import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // Read from the active NodeJS Momentum Sniper Bot journal
    const candidatePaths = [
      path.join(process.cwd(), 'optimized-jupiter-bot', 'signals', 'trade_journal.jsonl'),
      path.join(process.cwd(), '..', 'optimized-jupiter-bot', 'signals', 'trade_journal.jsonl')
    ];

    let logs: any[] = [];
    for (const dbPath of candidatePaths) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        const fileContent = fs.readFileSync(dbPath, 'utf8');
        logs = fileContent.trim().split('\n').filter(l => l.length > 5).map(l => JSON.parse(l));
        if (logs.length > 0) break;
      } catch { continue; }
    }

    let wins = 0;
    let sumProfit = 0;
    let totalTrades = 0;

    for (const log of logs) {
      // trade_journal.jsonl structure: { "action": "SELL", "pnlSol": 0.05, ... }
      if (log.action === 'SELL' && log.pnlSol !== undefined) {
        totalTrades++;
        if (log.pnlSol > 0) wins++;
        sumProfit += parseFloat(log.pnlSol);
      }
    }

    const winRate     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
    const totalPnL    = sumProfit >= 0
      ? `+${sumProfit.toFixed(4)} SOL`
      : `-${Math.abs(sumProfit).toFixed(4)} SOL`;

    const scanCount = logs.length;
    const volumeSol = (totalTrades * 0.02).toFixed(2); // Avg buy size 0.02

    return NextResponse.json({
      recentLogs:  logs.slice(-20).reverse(),
      totalTrades,
      winRate:     `${winRate}%`,
      totalPnL,
      volume:      `${volumeSol} SOL`,
      scans:       scanCount,
    }, {
      headers: { 'Cache-Control': 'no-store' }
    });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
