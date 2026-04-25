import { NextRequest, NextResponse } from "next/server";

const LEGACY_BACKEND_BASE_URL = "https://bitte-agent-navy.vercel.app";

function getBackendBaseUrl() {
  const value = process.env.PCP_API_BASE_URL?.trim();
  if (value) {
    return value.replace(/\/+$/, "");
  }
  return LEGACY_BACKEND_BASE_URL;
}

export function createUnavailableResponse(pathname: string) {
  return NextResponse.json(
    {
      ok: false,
      status: "backend_not_configured",
      message: "Set PCP_API_BASE_URL in the Vercel project to enable backend proxying.",
      path: pathname,
    },
    { status: 503 },
  );
}

export async function proxyRequest(req: NextRequest, pathname: string) {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) {
    return createUnavailableResponse(pathname);
  }

  const targetUrl = new URL(pathname, `${baseUrl}/`);
  req.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  const accept = req.headers.get("accept");
  if (contentType) headers.set("content-type", contentType);
  if (accept) headers.set("accept", accept);

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const upstream = await fetch(targetUrl, init);
  const body = await upstream.text();

  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function getHealthResponse() {
  const baseUrl = getBackendBaseUrl();

  try {
    const upstream = await fetch(new URL("/api/health", `${baseUrl}/`), {
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
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
        site: "pcprotocol.dev",
        status: "backend_unreachable",
        backendConfigured: Boolean(baseUrl),
        backendBaseUrl: baseUrl,
        error: error instanceof Error ? error.message : "Unknown backend health failure",
      },
      { status: 502 },
    );
  }
}
