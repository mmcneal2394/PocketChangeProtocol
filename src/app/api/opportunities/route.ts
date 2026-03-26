import { NextResponse } from "next/server";

// In-memory store until PostgreSQL is set up
let opportunities: any[] = [];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const filtered = status
    ? opportunities.filter(o => o.status === status)
    : opportunities;

  return NextResponse.json(filtered);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const opp = {
      id: body.id || crypto.randomUUID(),
      strategy: body.strategy,
      route: body.route,
      expectedProfit: body.expectedProfit || body.expected_profit_pct,
      tradeSize: body.tradeSize || body.trade_size_usdc,
      status: "PENDING",
      mode: body.mode || "paper",
      detectedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      executionTxHash: null,
      executionProfit: null,
      createdAt: new Date().toISOString(),
    };
    opportunities.push(opp);
    return NextResponse.json(opp, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, status, executionTxHash, executionProfit, resolvedBy } = body;

    const idx = opportunities.findIndex(o => o.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (status) opportunities[idx].status = status;
    if (executionTxHash) opportunities[idx].executionTxHash = executionTxHash;
    if (executionProfit !== undefined) opportunities[idx].executionProfit = executionProfit;
    if (resolvedBy) opportunities[idx].resolvedBy = resolvedBy;
    opportunities[idx].resolvedAt = new Date().toISOString();

    return NextResponse.json(opportunities[idx]);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
