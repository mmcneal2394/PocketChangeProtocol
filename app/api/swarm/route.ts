import { NextResponse } from "next/server";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

function getSwarmApiUrl() {
  const exactUrl = process.env.PCP_SWARM_API_URL?.trim();
  if (exactUrl) {
    return exactUrl;
  }

  const baseUrl = process.env.PCP_SWARM_BASE_URL?.trim();
  if (baseUrl) {
    return `${baseUrl.replace(/\/+$/, "")}/api/initial`;
  }

  return null;
}

export async function GET() {
  try {
    const swarmApiUrl = getSwarmApiUrl();
    if (!swarmApiUrl) {
      return NextResponse.json(
        {
          ok: false,
          status: "swarm_backend_not_configured",
          message: "Set PCP_SWARM_API_URL or PCP_SWARM_BASE_URL to enable live swarm hydration.",
        },
        { status: 503 },
      );
    }

    const upstream = await fetch(swarmApiUrl, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        status: "swarm_backend_unreachable",
        error: error instanceof Error ? error.message : "Unknown swarm backend failure",
      },
      { status: 502 },
    );
  }
}
