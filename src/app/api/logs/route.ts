import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

<<<<<<< HEAD
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
=======
// ── Sanitize a string — strip any base58 wallet addresses (44-char pubkeys) ──
function sanitize(str: string): string {
  if (!str) return str;
  // Replace full base58 pubkeys (43-44 chars) with masked version
  return str.replace(/[1-9A-HJ-NP-Za-km-z]{43,44}/g, "[wallet]");
}

export async function GET() {
  try {
    const candidatePaths = [
      path.join(process.cwd(), "engine-worker", "telemetry.jsonl"),
      path.join(process.cwd(), "telemetry.jsonl"),
    ];

    let fileContent = "";
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) { fileContent = fs.readFileSync(p, "utf-8"); break; }
    }

    if (!fileContent.trim()) {
      return NextResponse.json(
        [{ id: 0, route: "Vault engine standing by...", status: "IDLE", profit: "—", ok: true, hash: null }],
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const lines = fileContent.trim().split("\n");

    const parsedLogs = lines
      .filter(line => line.length > 5)
      .map((line, idx) => {
        try {
          const row = JSON.parse(line);
          const isSuccess = row.success === true || String(row.status).includes("SUCCESS");
          const profitSol = parseFloat(row.profit_sol || 0);

          return {
            id:     (row.timestamp_sec || idx) + idx,
            // Sanitize route — strip any wallet pubkeys if they somehow appear
            route:  sanitize(row.route || "Unknown Route"),
            status: row.status || (isSuccess ? "EXEC_SUCCESS" : "SKIPPED"),
            profit: profitSol !== 0
              ? (profitSol > 0 ? `+${profitSol.toFixed(6)} SOL` : `${profitSol.toFixed(6)} SOL`)
              : "—",
            ok:   isSuccess,
            // Only show first 8 chars of tx signature — not enough to identify wallet
            hash: row.tx_signature ? String(row.tx_signature).slice(0, 8) : null,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .reverse()   // newest first
      .slice(0, 25);

    return NextResponse.json(parsedLogs, {
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });

  } catch (e: any) {
    console.error("Logs API error:", e.message);
    return NextResponse.json(
      [{ id: 0, route: "Engine offline", status: "ERROR", profit: "—", ok: false, hash: null }],
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
}
