import { NextResponse } from "next/server";
import { Redis as UpstashRedis } from "@upstash/redis";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

type SwarmPayload = Record<string, unknown>;
const UPSTASH_SWARM_KEY = process.env.PCP_SWARM_UPSTASH_KEY?.trim() || "pcp:swarm:latest";
const UPSTASH_SWARM_MAX_AGE_MS = Number(process.env.PCP_SWARM_UPSTASH_MAX_AGE_MS || "90000");

const upstashClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new UpstashRedis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

function getPublicBaseUrl() {
  return (process.env.PCP_PUBLIC_SITE_URL || "https://pcprotocol.dev").replace(/\/+$/, "");
}

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

async function getUpstashPayload() {
  if (!upstashClient) return null;
  try {
    const raw = await upstashClient.get<string | Record<string, unknown>>(UPSTASH_SWARM_KEY);
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const payload = normalizePayload(parsed);
    const ageMs = Date.now() - Number(payload.ts || 0);
    if (!Number.isFinite(ageMs) || ageMs > UPSTASH_SWARM_MAX_AGE_MS) {
      return {
        ...payload,
        stale: true,
        degraded: true,
        status: "swarm_upstash_stale",
        message: "Swarm snapshot is available but stale.",
      };
    }
    return payload;
  } catch {
    return null;
  }
}

async function fetchPublicJson(pathname: string) {
  try {
    const response = await fetch(`${getPublicBaseUrl()}${pathname}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function persistUpstashPayload(payload: SwarmPayload) {
  if (!upstashClient) return;
  try {
    await upstashClient.set(UPSTASH_SWARM_KEY, payload);
  } catch {
    // Ignore write-back failures and continue serving the fresh payload.
  }
}

async function buildPublicSwarmSnapshot(seed?: SwarmPayload | null) {
  const [health, alpha, arb, tokenScan] = await Promise.all([
    fetchPublicJson("/api/health"),
    fetchPublicJson("/api/alpha-signals?limit=5"),
    fetchPublicJson("/api/arb-windows?capitalSol=1&minBps=3"),
    fetchPublicJson("/api/token-scan?minLiq=8000&limit=8"),
  ]);

  const signals = Array.isArray(alpha?.signals) ? alpha.signals : [];
  const windows = Array.isArray(arb?.windows) ? arb.windows : [];
  const tokens = Array.isArray(tokenScan?.tokens) ? tokenScan.tokens : [];
  const solPriceUsd = Number(tokenScan?.sol_price_usd || arb?.sol_price_usd || 0);

  if (!health && signals.length === 0 && windows.length === 0 && tokens.length === 0) {
    return null;
  }

  const base = normalizePayload(seed || {});
  const now = Date.now();
  const findings = signals.slice(0, 5).map((signal: any) => ({
    type: signal?.type || "SIGNAL",
    symbol: signal?.symbol || "UNK",
    mint: signal?.mint || "",
    score: Number(signal?.score || 0),
    action: signal?.action || "MONITOR",
    sources: Array.isArray(signal?.sources) ? signal.sources : [],
  }));
  const proposals = windows.slice(0, 3).map((window: any) => ({
    symbol: window?.symbol || "UNK",
    mint: window?.mint || "",
    net_bps: Number(window?.net_bps || 0),
    net_sol: Number(window?.net_sol || 0),
    capital_sol: Number(window?.capital_sol || 0),
  }));
  const trending = tokens.slice(0, 8).map((token: any) => ({
    symbol: token?.symbol || "UNK",
    mint: token?.mint || "",
    vol1h: Number(token?.volume_usd_24h || 0),
    chg1h: Number(token?.price_change_24h || 0),
    chg5m: 0,
    ratio: Number(token?.score || 0),
    buys: 0,
    sells: 0,
    mcap: 0,
    source: token?.source || "public",
    liquidity_usd: Number(token?.liquidity_usd || 0),
  }));

  return normalizePayload({
    ...base,
    ok: true,
    degraded: true,
    stale: false,
    status: "swarm_public_synthesized",
    message: "Using live public market snapshot while the private swarm publisher is unavailable.",
    ts: now,
    agents: [
      { name: "public-health", status: health?.status === "ok" ? "online" : "degraded" },
      { name: "public-alpha-signals", status: signals.length > 0 ? "online" : "quiet" },
      { name: "public-arb-windows", status: arb ? "online" : "degraded" },
      { name: "public-token-scan", status: tokens.length > 0 ? "online" : "degraded" },
    ],
    trending,
    findings,
    proposals,
    allocation: {
      source: "public-market-snapshot",
      sol_price_usd: solPriceUsd,
      profitable_count: Number(arb?.profitable_count || 0),
      scanned_at: arb?.scanned_at || tokenScan?.scanned_at || null,
      reason: "Private swarm publisher unavailable; synthesized from live public routes.",
    },
    last_optimizer_cycle: {
      source: "public-market-snapshot",
      generated_at: new Date(now).toISOString(),
    },
  });
}

export async function GET() {
  try {
    const upstashPayload = await getUpstashPayload();
    if (upstashPayload && !upstashPayload.stale) {
      return NextResponse.json(upstashPayload, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    const synthesizedPayload = await buildPublicSwarmSnapshot(upstashPayload);
    if (synthesizedPayload) {
      await persistUpstashPayload(synthesizedPayload);
      return NextResponse.json(synthesizedPayload, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    if (upstashPayload) {
      return NextResponse.json(upstashPayload, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    const attempts = getCandidateUrls().map(async (swarmApiUrl) => {
      try {
        const upstream = await fetch(swarmApiUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(1000),
        });
        if (!upstream.ok) return null;

        const text = await upstream.text();
        const payload = text ? JSON.parse(text) : {};
        return normalizePayload(payload);
      } catch {
        return null;
      }
    });

    const payload = (await Promise.all(attempts)).find(Boolean);
    if (payload) {
      return NextResponse.json(payload, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
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
