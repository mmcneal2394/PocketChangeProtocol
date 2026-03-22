import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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
}
