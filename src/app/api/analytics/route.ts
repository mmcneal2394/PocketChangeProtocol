import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // Try telemetry.jsonl from the engine-worker (Rust binary output)
    const candidatePaths = [
      path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl'),
      path.join(process.cwd(), 'telemetry.jsonl'),
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

    for (const log of logs) {
      if (log.status === 'EXEC_SUCCESS' || log.success === true) {
        wins++;
        sumProfit += parseFloat(log.profit_sol || 0);
      }
    }

    const totalTrades = logs.length;
    const winRate     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
    const totalPnL    = sumProfit >= 0
      ? `+${sumProfit.toFixed(4)} SOL`
      : `-${Math.abs(sumProfit).toFixed(4)} SOL`;

    // Volume = number of scans × average scan size (0.02 SOL) — realistic estimate
    const scanCount = logs.length;
    const volumeSol = (scanCount * 0.02).toFixed(2);

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
