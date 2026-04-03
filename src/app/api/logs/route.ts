import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
    try {
        const candidatePaths = [
          path.join(process.cwd(), "optimized-jupiter-bot", "signals", "trade_journal.jsonl"),
          path.join(process.cwd(), "..", "optimized-jupiter-bot", "signals", "trade_journal.jsonl")
        ];

        let telemetryPath = candidatePaths.find(p => fs.existsSync(p));

        if (!telemetryPath) {
            return NextResponse.json([{ id: 0, route: "No active swaps yet...", status: "PENDING", profit: "-", ok: true, hash: "..." }], {
                headers: { "Cache-Control": "no-store" }
            });
        }

        // Read all lines, split
        const fileContent = fs.readFileSync(telemetryPath, "utf-8");
        const lines = fileContent.trim().split("\n");

        // Parse lines, format to our Next.js UI expected properties and slice top 10
        const parsedLogs = lines
            .filter(line => line.length > 5) // Skip empty/malformed newlines
            .map((line, idx) => {
                const row = JSON.parse(line);

                // New telemetry schema (event-based) vs legacy schema
                const isNewFormat = "event" in row;

                const isLoss = row.pnlSol !== undefined && row.pnlSol < 0;
                
                const route = row.action === 'SELL' 
                    ? `Sniper Close ${row.mint?.slice(0, 4)}... (Held ${row.holdTimeMin}m)`
                    : row.action === 'BUY'
                        ? `Velocity Entry ${row.mint?.slice(0,4)}...`
                        : (row.action || "SWAP");

                const status = row.isLossCut ? 'STOP LOSS' : 'EXECUTED';
                
                const profitVal = row.pnlSol || 0;
                const profit = profitVal > 0
                    ? `+$${(profitVal * 150).toFixed(6)}` // Approximate USDC mapping
                    : `-$${Math.abs(profitVal * 150).toFixed(6)}`;

                const ok = !isLoss;
                const hash = row.tradeId ? `${row.tradeId.split('-')[0]} // ${row.sig || row.signature}` : (row.sig || row.signature);
                const timestamp = row.ts || row.timestamp || idx;

                return {
                    id: row.tradeId || (timestamp + idx),
                    route,
                    status,
                    profit,
                    ok,
                    hash,
                    // Pass through new fields for downstream consumers
                    ...(isNewFormat && {
                        strategy: row.strategy,
                        expectedProfit: row.expected_profit_pct,
                        tradeSize: row.trade_size_usdc,
                        mode: row.mode,
                    }),
                };
            })
            .reverse() // Display newest first
            .slice(0, 10);

        return NextResponse.json(parsedLogs.length ? parsedLogs : [], {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            }
        });

    } catch (e: any) {
        console.error("Failed to parse telemetry map: ", e.message);
        return NextResponse.json([{ id: 0, route: "Error parsing backend", status: "ERROR", profit: "-", ok: false, hash: "" }], { status: 500 });
    }
}
