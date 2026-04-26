#!/usr/bin/env node

const PUBLIC_BASE_URL = (process.env.PCP_PUBLIC_BASE_URL || "https://pcprotocol.dev").replace(/\/+$/, "");
const LEGACY_BASE_URL = (process.env.PCP_LEGACY_BASE_URL || "https://bitte-agent-navy.vercel.app").replace(/\/+$/, "");
const TIMEOUT_MS = Number.parseInt(process.env.PCP_MONITOR_TIMEOUT_MS || "15000", 10);

const results = [];
let failed = false;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchResponse(label, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json, text/html;q=0.9",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });

  const text = await response.text();
  return {
    label,
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
  };
}

function pushResult(status, label, detail) {
  results.push({ status, label, detail });
  if (status === "FAIL") {
    failed = true;
  }
}

async function checkHtml(label, url, expectations = {}) {
  const response = await fetchResponse(label, url);
  assert(response.status === 200, `expected HTTP 200, got ${response.status}`);
  assert((response.headers["content-type"] || "").includes("text/html"), "expected HTML content");

  if (expectations.includes) {
    for (const needle of expectations.includes) {
      assert(response.text.includes(needle), `expected HTML to include "${needle}"`);
    }
  }

  if (expectations.excludes) {
    for (const needle of expectations.excludes) {
      assert(!response.text.includes(needle), `expected HTML to exclude "${needle}"`);
    }
  }

  pushResult("PASS", label, `200 HTML from ${url}`);
}

async function checkJson(label, url, validator, options = {}) {
  const response = await fetchResponse(label, url, options);
  assert(response.status === 200, `expected HTTP 200, got ${response.status}`);

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`expected JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }

  await validator(data);
  pushResult("PASS", label, `200 JSON from ${url}`);
  return data;
}

async function checkSwarm(label, url) {
  const response = await fetchResponse(label, url);

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`expected JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 200) {
    assert(data && typeof data === "object", "expected object payload");
    assert(Array.isArray(data.trending), "expected trending array");
    assert(Array.isArray(data.last_trades), "expected last_trades array");
    pushResult("PASS", label, `200 JSON from ${url}`);
    return data;
  }

  if (response.status === 503 && data?.status === "swarm_backend_not_configured") {
    throw new Error("public swarm route exists but swarm backend env is not configured");
  }

  throw new Error(`expected HTTP 200, got ${response.status}`);
}

async function main() {
  console.log(`Checking public site: ${PUBLIC_BASE_URL}`);
  console.log(`Checking legacy backend: ${LEGACY_BASE_URL}`);

  const publicHealthPromise = checkJson(
    "Public health",
    `${PUBLIC_BASE_URL}/api/health`,
    async (data) => {
      assert(data && typeof data === "object", "expected object payload");
      assert(data.status === "ok", 'expected health status "ok"');
      assert(Array.isArray(data.capabilities), "expected capabilities array");
      for (const capability of ["token-scan", "arb-windows", "alpha-signals", "code-audit"]) {
        assert(data.capabilities.includes(capability), `missing capability "${capability}"`);
      }
      assert(typeof data.agent === "string" && data.agent.length > 0, "expected agent name");
      assert(typeof data.version === "string" && data.version.length > 0, "expected version");
    },
  );

  const legacyHealthPromise = checkJson(
    "Legacy health",
    `${LEGACY_BASE_URL}/api/health`,
    async (data) => {
      assert(data && typeof data === "object", "expected object payload");
      assert(data.status === "ok", 'expected health status "ok"');
      assert(Array.isArray(data.capabilities), "expected capabilities array");
    },
  );

  await checkHtml("Public landing page", `${PUBLIC_BASE_URL}/`, {
    includes: ["PocketChange Protocol"],
    excludes: ["pcprotcol.dev"],
  });

  const [publicHealth] = await Promise.all([publicHealthPromise, legacyHealthPromise]);
  assert(publicHealth.agent === "PocketChange Protocol Open Agent", "unexpected public health agent");
  pushResult("PASS", "Public health agent", "public health agent is the expected direct implementation");

  await Promise.all([
    checkJson(
      "Public arb windows",
      `${PUBLIC_BASE_URL}/api/arb-windows?capitalSol=1.0&minBps=3`,
      async (data) => {
        assert(Array.isArray(data.windows), "expected windows array");
        assert(typeof data.profitable_count === "number", "expected profitable_count number");
        assert(typeof data.sol_price_usd === "number" && data.sol_price_usd > 0, "expected positive sol_price_usd");
      },
    ),
    checkJson(
      "Public alpha signals",
      `${PUBLIC_BASE_URL}/api/alpha-signals`,
      async (data) => {
        assert(Array.isArray(data.signals), "expected signals array");
      },
    ),
    checkSwarm("Public swarm", `${PUBLIC_BASE_URL}/api/swarm`),
    checkJson(
      "Public token scan",
      `${PUBLIC_BASE_URL}/api/token-scan?minLiq=10000&limit=3`,
      async (data) => {
        assert(Array.isArray(data.tokens), "expected tokens array");
        assert(typeof data.sol_price_usd === "number" && data.sol_price_usd > 0, "expected positive sol_price_usd");
      },
    ),
  ]);
}

async function printSummary() {
  const lines = results.map((result) => `- ${result.status} ${result.label}: ${result.detail}`);
  const summary = ["# Public Endpoint Smoke Test", "", ...lines, ""].join("\n");

  console.log("\n" + summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  pushResult("FAIL", "Smoke test", message);
}

await printSummary();

if (failed) {
  process.exit(1);
}
