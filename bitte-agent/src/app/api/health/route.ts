import { NextResponse } from 'next/server';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const START = Date.now();

export function GET() {
  return NextResponse.json({
    status:          'ok',
    version:         '1.0.0',
    agent:           'PocketChange Protocol Open Agent',
    uptime_ms:       Date.now() - START,
    capabilities:    ['token-scan', 'arb-windows', 'alpha-signals', 'code-audit'],
    powered_by:      'Jupiter lite-api + DexScreener + Helius RPC',
  }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
