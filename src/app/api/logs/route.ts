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
                return {
                    id: row.timestamp_sec + idx, // Unique mock ID
                    route: row.route,
                    status: row.status,
                    profit: row.profit_sol > 0 ? `+$${row.profit_sol.toFixed(6)} USDC` : `-$${Math.abs(row.profit_sol).toFixed(6)} USDC`,
                    ok: row.success,
                    hash: row.tx_signature
                }
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
