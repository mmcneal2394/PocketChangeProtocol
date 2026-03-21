import { NextResponse } from 'next/server';

const ENGINE_URL = process.env.ENGINE_API_URL || 'http://localhost:3002/api/status';

export async function GET() {
  try {
    const res = await fetch(ENGINE_URL, { next: { revalidate: 0 }, cache: 'no-store' });
    if (!res.ok) throw new Error(`engine ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: unknown) {
    // Return empty but valid shape so the UI degrades gracefully
    return NextResponse.json({
      scans: 0, trades: 0, profits: 0, losses: 0,
      netSol: 0, tradeSizeSol: 0.05,
      lastScans: [], tradeEvents: [],
      sniperStatus: 'Engine offline',
      error: e instanceof Error ? e.message : 'unknown',
    }, { status: 200 });
  }
}
