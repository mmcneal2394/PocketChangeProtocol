import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
    try {
        // Find the Rust worker's telemetry output file locally
        const telemetryPath = path.join(process.cwd(), "engine-worker", "telemetry.jsonl");

        if (!fs.existsSync(telemetryPath)) {
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

                const route = isNewFormat
                    ? (row.route || row.strategy || row.event)
                    : row.route;

                const status = isNewFormat
                    ? (row.status || row.event?.toUpperCase() || "UNKNOWN")
                    : row.status;

                const profitVal = isNewFormat
                    ? (row.execution_profit ?? row.expected_profit_pct ?? row.profit_sol ?? 0)
                    : (row.profit_sol ?? 0);

                const profit = profitVal > 0
                    ? `+$${profitVal.toFixed(6)} USDC`
                    : `-$${Math.abs(profitVal).toFixed(6)} USDC`;

                const ok = isNewFormat
                    ? (row.success !== undefined ? row.success : row.status === "EXECUTED" || row.status === "SUCCESS")
                    : row.success;

                const hash = isNewFormat
                    ? (row.execution_tx_hash || row.tx_signature || null)
                    : row.tx_signature;

                const timestamp = isNewFormat
                    ? (row.detected_at || row.timestamp_sec || idx)
                    : (row.timestamp_sec || idx);

                return {
                    id: typeof timestamp === "string" ? Date.parse(timestamp) + idx : timestamp + idx,
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
