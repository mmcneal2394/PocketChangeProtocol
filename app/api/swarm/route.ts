import { NextResponse } from "next/server";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

type SwarmPayload = Record<string, unknown>;

function createFallbackPayload(status: string, message: string): SwarmPayload {
  return {
    ok: false,
    degraded: true,
    stale: true,
    status,
    error: message,
    message,
    ts: Date.now(),
    wallet: null,
    trackedAssets: [],
    parameters: {},
    trades: [],
    agents: [],
    portfolio: {
      trades: 0,
      wins: 0,
      losses: 0,
      wr_pct: 0,
      net_pnl: 0,
      profit_factor: "N/A",
      exits: {},
    },
    open_positions: [],
    blacklist_count: 0,
    last_trades: [],
    trending: [],
    allocation: { reason: "Swarm backend unavailable" },
    findings: [],
    proposals: [],
    last_optimizer_cycle: null,
  };
}

function normalizePayload(payload: any): SwarmPayload {
  const fallback = createFallbackPayload("swarm_backend_degraded", "Using fallback swarm payload");
  return {
    ...fallback,
    ...(payload && typeof payload === "object" ? payload : {}),
    ts: typeof payload?.ts === "number" ? payload.ts : Date.now(),
    wallet: payload?.wallet ?? fallback.wallet,
    trackedAssets: Array.isArray(payload?.trackedAssets) ? payload.trackedAssets : fallback.trackedAssets,
    parameters: payload?.parameters && typeof payload.parameters === "object" ? payload.parameters : fallback.parameters,
    trades: Array.isArray(payload?.trades) ? payload.trades : fallback.trades,
    agents: Array.isArray(payload?.agents) ? payload.agents : fallback.agents,
    portfolio: payload?.portfolio && typeof payload.portfolio === "object" ? payload.portfolio : fallback.portfolio,
    open_positions: Array.isArray(payload?.open_positions) ? payload.open_positions : fallback.open_positions,
    blacklist_count: typeof payload?.blacklist_count === "number" ? payload.blacklist_count : fallback.blacklist_count,
    last_trades: Array.isArray(payload?.last_trades) ? payload.last_trades : fallback.last_trades,
    trending: Array.isArray(payload?.trending) ? payload.trending : fallback.trending,
    allocation: payload?.allocation && typeof payload.allocation === "object" ? payload.allocation : fallback.allocation,
    findings: Array.isArray(payload?.findings) ? payload.findings : fallback.findings,
    proposals: Array.isArray(payload?.proposals) ? payload.proposals : fallback.proposals,
    last_optimizer_cycle:
      payload?.last_optimizer_cycle && typeof payload.last_optimizer_cycle === "object"
        ? payload.last_optimizer_cycle
        : fallback.last_optimizer_cycle,
  };
}

function getConfiguredSwarmApiUrl() {
  const exactUrl = process.env.PCP_SWARM_API_URL?.trim();
  if (exactUrl) {
    return [exactUrl];
  }

  const baseUrl = process.env.PCP_SWARM_BASE_URL?.trim();
  if (baseUrl) {
    const normalized = baseUrl.replace(/\/+$/, "");
    return [`${normalized}/metrics`, `${normalized}/api/initial`];
  }

  return [];
}

function getCandidateUrls() {
  const configured = getConfiguredSwarmApiUrl();
  if (configured.length > 0) return configured;

  return [
    "https://pcprotocol.dev:3333/metrics",
    "http://pcprotocol.dev:3333/metrics",
    "https://pcprotocol.dev:3002/api/initial",
    "http://pcprotocol.dev:3002/api/initial",
  ];
}

export async function GET() {
  try {
    for (const swarmApiUrl of getCandidateUrls()) {
      try {
        const upstream = await fetch(swarmApiUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(4000),
        });
        if (!upstream.ok) continue;

        const text = await upstream.text();
        const payload = text ? JSON.parse(text) : {};
        return NextResponse.json(normalizePayload(payload), {
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      } catch {
        // Try the next candidate.
      }
    }

    return NextResponse.json(
      createFallbackPayload(
        "swarm_backend_unreachable",
        "Live swarm backend is not reachable from the public edge yet.",
      ),
      {
        status: 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return NextResponse.json(
      createFallbackPayload(
        "swarm_backend_unreachable",
        error instanceof Error ? error.message : "Unknown swarm backend failure",
      ),
      {
        status: 200,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
