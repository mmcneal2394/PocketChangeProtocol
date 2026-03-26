import { NextResponse } from 'next/server';

const DROPLET_METRICS = 'http://64.23.173.160:3333/metrics';

let cache: { data: any; ts: number } | null = null;
const CACHE_MS = 10_000; // 10s cache

export async function GET() {
  try {
    // Serve from cache if fresh
    if (cache && Date.now() - cache.ts < CACHE_MS) {
      return NextResponse.json(cache.data, { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } });
    }

    const res = await fetch(DROPLET_METRICS, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Metrics server returned ${res.status}`);
    const data = await res.json();

    cache = { data, ts: Date.now() };
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } });
  } catch (e: any) {
    // Return stale cache rather than error if available
    if (cache) return NextResponse.json({ ...cache.data, stale: true });
    return NextResponse.json({ error: e.message, agents: [], portfolio: {}, open_positions: [], last_trades: [], trending: [], findings: [] }, { status: 503 });
  }
}
