import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  LocalPaperTraderState,
  PaperMark,
  summarizeLocalPaperTrader,
  isFreshMark,
} from './local_paper_trader';

const HOST = process.env.LOCAL_PAPER_DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCAL_PAPER_DASHBOARD_PORT || 8790);
const STATE_FILE = process.env.LOCAL_PAPER_STATE_FILE || path.join(process.cwd(), 'artifacts/paper/local-paper-trader-state.json');
const MARKS_FILE = process.env.LOCAL_PAPER_MARKS_FILE || path.join(process.cwd(), 'artifacts/paper/local-paper-marks.json');
const PRODUCTIVE_FILE = process.env.PRODUCTIVE_TREASURY_STATE_FILE || path.join(process.cwd(), 'artifacts/paper/productive-treasury.json');
const PRODUCTIVE_LAUNCHPAD_FILE = process.env.PRODUCTIVE_LAUNCHPAD_REGISTRY_FILE || path.join(process.cwd(), 'config/productive-launchpad-registry.json');
const STREAM_INTERVAL_MS = 1000;
let cachedStateMtime = -1;
let cachedState: LocalPaperTraderState | null = null;

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSol(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(5)} SOL`;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusTone(status: string): string {
  return status === 'fresh' ? 'good' : status === 'stale' ? 'warn' : status === 'conflict' ? 'bad' : 'muted';
}

function displayMarketCap(discovery: any) {
  if (!discovery) return null;
  try {
    const info = discovery.providerPayload?.info;
    const pool = discovery.providerPayload?.pool;
    if (info && pool) return require('./market_cap').marketCap(info, discovery.mint, discovery.marketCap?.observedAt || discovery.observedAt, pool);
  } catch { /* Preserve the recorded value when legacy evidence cannot be recalculated. */ }
  return discovery.marketCap || null;
}

function loadSnapshot() {
  let mtime = -1;
  try { mtime = fs.statSync(STATE_FILE).mtimeMs; } catch { /* State may not exist yet. */ }
  if (mtime >= 0 && mtime !== cachedStateMtime) {
    cachedState = readJson<LocalPaperTraderState | null>(STATE_FILE, null);
    cachedStateMtime = mtime;
  }
  const state = cachedState;
  const productive = readJson<any | null>(PRODUCTIVE_FILE, null);
  const productiveLaunchpads = readJson<any | null>(PRODUCTIVE_LAUNCHPAD_FILE, null);
  const fallbackMarks = readJson<Record<string, PaperMark>>(MARKS_FILE, {});
  const marks = Object.fromEntries(Object.entries(state?.marksByMint || fallbackMarks).map(([mint, mark]) => [mint, { ...mark, fresh: isFreshMark(mark, Date.now()) }]));
  if (!state) return { state: null, marks, summary: null, productive, productiveLaunchpads };
  return { state, marks, summary: summarizeLocalPaperTrader(state, marks), productive, productiveLaunchpads };
}

function dashboardIndex(snapshot: ReturnType<typeof loadSnapshot>, streamedAt = Date.now()) {
  const state: any = snapshot.state;
  if (!state) return { schemaVersion: 'pcp-dashboard-index/v1', streamedAt, revision: cachedStateMtime, ready: false };
  const candidates = (state.live?.candidates || []).map((row: any) => {
    const d = row.discovery;
    return {
      mint: row.mint, symbol: row.symbol || d?.identity?.symbol || null, name: d?.identity?.name || null,
      source: row.source || null, decision: row.decision || 'queued', reason: row.reason || null,
      discoveredAt: row.discoveredAt || null, checkedAt: row.checkedAt || null, pool: row.pool || d?.pool || null,
      launch: d ? { platform: d.migration?.platform || null, status: d.migration?.status ?? null, progress: d.migration?.progress ?? null, createdAt: d.createdAt || null } : null,
      market: d ? { marketCap: displayMarketCap(d), liquidityUsd: d.liquidityUsd ?? null, holders: d.holderCount ?? null, top10: d.concentration?.top10 ?? null,
        supplyControl: d.supplyControl ? { profile: d.supplyControl.profile?.id || null, monitored: d.supplyControl.monitoredControllerRatio ?? null,
          marketMaker: d.supplyControl.knownMarketMakerRatio ?? null, pool: d.supplyControl.verifiedLiquidityPoolRatio ?? null,
          unattributed: d.supplyControl.unattributedTop10Ratio ?? null } : null } : null,
      flow1m: d ? { buys: d.flow?.buys1m ?? null, sells: d.flow?.sells1m ?? null, swaps: d.flow?.swaps1m ?? null, volumeUsd: d.flow?.volume1mUsd ?? null } : null,
      signal: d ? { lane: d.entryLane || null, pattern: d.pattern || null, issue: d.patternIssue || null } : null,
      checks: d?.checks || null,
    };
  });
  const positions = (state.positions || []).map((position: any) => ({
    id: position.id, mint: position.mint, symbol: position.symbol, openedAt: position.openedAt, closedAt: position.closedAt,
    remainingTokenAmount: position.remainingTokenAmount, originalTokenAmount: position.originalTokenAmount,
    entryPriceSol: position.entryPriceSol, originalCapitalSol: position.originalCapitalSol,
    realizedPnlSol: position.realizedPnlSol, closeReason: position.closeReason || null,
    entryMode: position.evidence?.entryMode || position.evidence?.pattern?.lane || position.evidence?.discovery?.pattern?.name || null,
    marketCap: position.marketCap || null,
    traffic: position.traffic || null, exitHealth: position.exitHealth || null, exitPending: position.exitPending || null,
  }));
  return {
    schemaVersion: 'pcp-dashboard-index/v1', streamedAt, revision: cachedStateMtime, ready: true,
    generatedAt: state.generatedAt, execution: state.execution, config: state.config, summary: snapshot.summary,
    worker: { status: state.live?.status || 'missing', heartbeat: state.live?.heartbeat || null, cycle: state.live?.cycle || null },
    capital: { availableSol: state.availableCapitalSol, initialSol: state.config?.startingCapitalSol },
    candidateOrder: candidates.map((row: any) => row.mint), candidatesByMint: Object.fromEntries(candidates.map((row: any) => [row.mint, row])),
    positionOrder: positions.map((row: any) => row.id), positionsById: Object.fromEntries(positions.map((row: any) => [row.id, row])),
    marksByMint: snapshot.marks, pipelineBySource: state.pipeline || {}, providerByName: state.rpcUsage || {},
    productiveTreasury: snapshot.productive,
    recentEvents: (state.events || []).slice(0, 25),
  };
}

function renderOperationalShell(state: any, summary: any, positionRows: string, eventRows: string, pipelineRows: string, usageRows: string): string {
  const heartbeatAge = Math.max(0, Date.now() - Number(state.live?.heartbeat || 0));
  const workerHealthy = state.live?.status === 'running' && heartbeatAge <= 60000;
  const strategy = state.live?.entryPolicy?.id || state.run?.strategy || 'unassigned';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"/><meta name="viewport" content="width=device-width,initial-scale=1"><title>PCP Paper Operations</title><style>
    :root{--bg:#0d1113;--surface:#151a1c;--surface-2:#1a2022;--line:#343c3f;--text:#edf2f3;--muted:#94a0a4;--cyan:#4fc3d7;--good:#45d49d;--bad:#ff6b73;--warn:#e5bd62}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}.top{min-height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:9px 20px;background:#111719}.brand{font:700 18px system-ui,sans-serif;letter-spacing:0}.brand b{color:var(--cyan)}.top-spacer{flex:1}.status-pill,.stream-status{border:1px solid var(--line);border-radius:3px;padding:5px 8px;font-size:10px;font-weight:800}.status-pill{color:var(--warn);border-color:#685936}.stream-status{color:var(--muted)}.stream-status.connected{color:var(--good);border-color:#285c49}.wrap{padding:14px;max-width:1680px;margin:auto}.view-tabs{display:flex;gap:3px;margin-bottom:12px;border-bottom:1px solid var(--line);overflow-x:auto}.view-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:700 12px ui-monospace,monospace;padding:10px 14px;cursor:pointer;white-space:nowrap}.view-tab:hover{color:var(--text)}.view-tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--cyan)}.view-tab:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}.dashboard-view[hidden]{display:none!important}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:10px}.metric,.panel{border:1px solid var(--line);border-radius:4px;background:var(--surface)}.metric{padding:12px;min-height:84px}.label{font-size:10px;color:var(--muted);text-transform:uppercase}.value{font-size:21px;font-weight:800;margin:8px 0 4px;overflow-wrap:anywhere}.sub{color:var(--muted);font-size:11px;line-height:1.35}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.section-stack{display:grid;gap:10px}.ops-grid,.bottom{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.panel h2,.panel>summary{font:700 14px system-ui,sans-serif;margin:0;padding:12px 14px;border-bottom:1px solid var(--line);letter-spacing:0}.panel>summary{cursor:pointer;display:flex;align-items:center;gap:7px;list-style:none;user-select:none}.panel>summary::-webkit-details-marker{display:none}.panel>summary::before{content:'›';color:var(--cyan);font-size:19px;line-height:12px;transform:rotate(90deg);transition:transform .15s ease}.panel:not([open])>summary{border-bottom:0}.panel:not([open])>summary::before{transform:rotate(0)}.panel>summary:focus-visible{outline:2px solid var(--cyan);outline-offset:-3px}.table-wrap{overflow:auto;max-width:100%}table{width:100%;border-collapse:collapse;min-width:680px}th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #293235;vertical-align:middle}th{font-size:10px;color:var(--muted);font-weight:600}td small{display:block;color:var(--muted);margin-top:3px;line-height:1.3}.none{color:var(--muted);text-align:center;padding:18px}.meter{height:6px;width:100px;background:#263034;margin-bottom:5px}.meter i{display:block;height:100%;background:var(--cyan)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.event{font-weight:700;text-transform:uppercase;font-size:10px}.rotation_75,.entry{color:var(--cyan)}.force_close_4h{color:var(--warn)}.mark_stale,.candidate_rejected{color:var(--bad)}@media(max-width:1050px){.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.ops-grid,.bottom{grid-template-columns:minmax(0,1fr)}}@media(max-width:620px){.wrap{padding:9px}.top{padding:8px 10px}.brand{font-size:16px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{min-height:78px;padding:10px}.value{font-size:18px}.view-tab{padding:9px 11px}.panel h2,.panel>summary{font-size:13px}.top .status-pill{font-size:9px}}
  </style></head><body><header class="top"><div class="brand"><b>PCP</b> PAPER OPS</div><span id="stream-status" class="stream-status">CONNECTING</span><span class="top-spacer"></span><strong class="status-pill">PAPER ONLY</strong></header><main class="wrap"><nav class="view-tabs" aria-label="Dashboard views"><button class="view-tab" type="button" data-view-target="overview" aria-selected="true">Overview</button><button class="view-tab" type="button" data-view-target="ledger" aria-selected="false">Ledger</button><button class="view-tab" type="button" data-view-target="scout" aria-selected="false">Scout</button><button class="view-tab" type="button" data-view-target="productive" aria-selected="false">Productive</button><button class="view-tab" type="button" data-view-target="system" aria-selected="false">System</button></nav><section class="dashboard-view section-stack" data-dashboard-view="overview"><section class="metrics"><div class="metric"><div class="label">Available capital</div><div class="value">${Number(state.availableCapitalSol).toFixed(5)} SOL</div><div class="sub">${Number(state.config.startingCapitalSol).toFixed(2)} SOL funded</div></div><div class="metric"><div class="label">Realized PnL</div><div class="value ${summary.realizedPnlSol >= 0 ? 'good' : 'bad'}">${formatSol(summary.realizedPnlSol)}</div><div class="sub">${summary.closedPositions} closed position${summary.closedPositions === 1 ? '' : 's'}</div></div><div class="metric"><div class="label">Open positions</div><div class="value">${summary.openPositions} / ${Number(state.config.maxOpenPositions || 0)}</div><div class="sub">${summary.rotatedRunners} retained runner${summary.rotatedRunners === 1 ? '' : 's'}</div></div><div class="metric"><div class="label">Worker</div><div class="value ${workerHealthy ? 'good' : 'bad'}">${workerHealthy ? 'RUNNING' : 'ATTENTION'}</div><div class="sub">Heartbeat ${formatAge(heartbeatAge)} ago</div></div><div class="metric"><div class="label">Strategy</div><div class="value" style="font-size:15px">${escapeHtml(strategy)}</div><div class="sub">TP ${Number(state.config.takeProfitPct || 0)}% · SL ${Number(state.config.stopLossPct || 0)}%</div></div></section><section class="panel"><h2>Open paper positions</h2><div class="table-wrap"><table><thead><tr><th>Mint / symbol</th><th>Market cap USD</th><th>Entry</th><th>Mark</th><th>PnL</th><th>Held</th><th>10m rotation</th><th>Runner</th><th>4h close</th></tr></thead><tbody>${positionRows}</tbody></table></div></section><section class="panel"><h2>Recent paper events</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Symbol</th><th>Detail</th><th>PnL</th></tr></thead><tbody>${eventRows}</tbody></table></div></section></section><section class="dashboard-view section-stack" data-dashboard-view="system" hidden><section class="ops-grid"><details class="panel" data-panel-key="source-pipeline" open><summary>Source health</summary><div class="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Age</th><th>Detail</th></tr></thead><tbody>${pipelineRows}</tbody></table></div></details><details class="panel" data-panel-key="provider-usage" open><summary>Provider usage</summary><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Requests</th><th>Success</th><th>Errors</th><th>Avg ms</th></tr></thead><tbody>${usageRows}</tbody></table></div></details></section></section></main></body></html>`;
}

function render(snapshot: ReturnType<typeof loadSnapshot>): string {
  const { state, marks, summary } = snapshot;
  if (!state || !summary) {
    return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local Paper Trader</title><style>body{margin:0;background:#081018;color:#d9e4ed;font:15px ui-monospace,monospace;display:grid;min-height:100vh;place-items:center}.empty{border:1px solid #2c4050;padding:28px;max-width:600px;background:#0d1821}.empty h1{margin-top:0;color:#5ed4ef}</style></head><body><main class="empty"><h1>Local Paper Trader</h1><p>Waiting for <code>${escapeHtml(STATE_FILE)}</code>.</p><p>Execution is disabled. Start the paper runner with a provider snapshot to populate this dashboard.</p></main></body></html>`;
  }

  const positionRows = state.positions.filter((position) => position.closedAt === null).map((position) => {
    const mark = marks[position.mint];
    const heldMs = Date.now() - position.openedAt;
    const traffic = (position as any).traffic;
    const inactivity = state.config.rotationTrigger === 'inactivity';
    const quietMs = traffic?.quietSince != null && Date.now() - traffic.checkedAt <= 30000 ? Math.max(0, Date.now() - Math.max(position.openedAt, traffic.quietSince)) : 0;
    const rotationPct = Math.min(100, Math.round(((inactivity ? quietMs : heldMs) / state.config.rotationMs) * 100));
    const closeRemaining = Math.max(0, state.config.maxHoldMs - heldMs);
    const unrealized = mark?.fresh && mark.priceSol > 0
      ? (position.remainingTokenAmount * mark.priceSol * (1 - state.config.modeledFeeBps / 10_000)) - (position.originalCapitalSol * (position.remainingTokenAmount / position.originalTokenAmount))
      : null;
    return `<tr><td><strong>${escapeHtml(position.symbol)}</strong><small>${escapeHtml(position.mint.slice(0, 8))}...</small></td><td>${position.entryPriceSol.toFixed(8)}</td><td>${mark?.fresh ? mark.priceSol.toFixed(8) : 'stale'}</td><td class="${(unrealized || 0) >= 0 ? 'good' : 'bad'}">${formatSol(unrealized)}</td><td>${formatAge(heldMs)}</td><td><div class="meter"><i style="width:${rotationPct}%"></i></div><small>${position.rotationAt ? '75% rotated' : `${rotationPct}% to ${state.config.inactivityExit === 'full' ? 'inactivity exit' : 'rotation'}`}</small></td><td>${position.rotationAt ? '25% active' : 'full position'}</td><td>${formatAge(closeRemaining)} left</td></tr>`;
  }).map((row, i) => {
    const p = state.positions.filter(p => p.closedAt === null)[i] as any;
    const cap = p.marketCap;
    const cell = `<td>${escapeHtml(require('./market_cap').marketCapLabel(cap))}<small>${cap?.observedAt ? `Received ${formatAge(Math.max(0, Date.now() - cap.observedAt))} ago` : 'Awaiting data'}</small></td>`;
    return row.replace('</td>', `</td>${cell}`);
  }).join('') || '<tr><td class="none" colspan="9">No open paper positions.</td></tr>';

  const eventRows = state.events.slice(0, 12).map((event) => `<tr><td>${new Date(event.ts).toLocaleTimeString()}</td><td class="event ${escapeHtml(event.type)}">${escapeHtml(event.type.replace(/_/g, ' '))}</td><td>${escapeHtml(event.symbol)}</td><td>${escapeHtml(event.detail)}</td><td class="${(event.pnlSol || 0) >= 0 ? 'good' : 'bad'}">${event.pnlSol === undefined ? '---' : formatSol(event.pnlSol)}</td></tr>`).join('') || '<tr><td class="none" colspan="5">No paper events yet.</td></tr>';

  const pipelineRows = Object.entries(state.pipeline).map(([source, value]) => `<tr><td>${escapeHtml(source)}</td><td><span class="dot ${statusTone(value.status)}"></span>${escapeHtml(value.status)}</td><td>${value.updatedAt ? formatAge(Math.max(0, state.generatedAt - value.updatedAt)) : 'n/a'}</td><td>${escapeHtml(value.detail || '')}</td></tr>`).join('') || '<tr><td class="none" colspan="4">No source pipeline telemetry yet.</td></tr>';
  const usageRows = Object.entries(state.rpcUsage).map(([provider, usage]) => {
    const errors = Number(usage.errors || 0);
    const requests = Number(usage.requests || 0);
    const successRate = requests ? ((Number(usage.successes || 0) / requests) * 100).toFixed(1) : 'n/a';
    return `<tr><td>${escapeHtml(provider)}</td><td>${requests.toLocaleString()}</td><td class="good">${successRate}${successRate === 'n/a' ? '' : '%'}</td><td class="${errors ? 'bad' : 'good'}">${errors}</td><td>${usage.averageLatencyMs ?? 'n/a'}</td></tr>`;
  }).join('') || '<tr><td class="none" colspan="5">No RPC/provider telemetry yet.</td></tr>';

  if (process.env.PCP_DASHBOARD_LEGACY !== '1') {
    return renderOperationalShell(state, summary, positionRows, eventRows, pipelineRows, usageRows);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Paper Trader</title><style>
    :root{--bg:#071017;--surface:#0b1720;--surface-2:#0d1d28;--line:#223848;--text:#dce9f0;--muted:#91a6b5;--cyan:#42d3ed;--good:#27e59c;--bad:#ff6571;--warn:#f5c451}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}.top{height:54px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:17px;padding:0 20px;background:#0a141c}.brand{font:700 19px system-ui,sans-serif;letter-spacing:0}.brand b{color:var(--cyan)}.status{margin-left:auto;background:var(--warn);color:#0d1418;font-weight:800;padding:6px 12px}.wrap{padding:16px;max-width:1680px;margin:auto}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:12px}.metric,.panel{border:1px solid var(--line);background:var(--surface)}.metric{padding:15px;min-height:103px}.label{font-size:12px;color:var(--muted)}.value{font-size:25px;font-weight:800;margin:10px 0 5px}.sub{color:var(--muted);font-size:12px}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.layout{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(320px,.7fr);gap:12px;margin-bottom:12px}.panel h2,.panel>summary{font:700 16px system-ui,sans-serif;margin:0;padding:14px 15px;border-bottom:1px solid var(--line)}.panel>summary{cursor:pointer;display:flex;align-items:center;gap:9px;list-style:none;user-select:none}.panel>summary::-webkit-details-marker{display:none}.panel>summary::before{content:'›';color:var(--cyan);font-size:22px;line-height:14px;transform:rotate(90deg);transition:transform .15s ease}.panel:not([open])>summary{border-bottom:0}.panel:not([open])>summary::before{transform:rotate(0)}.panel>summary:focus-visible{outline:2px solid var(--cyan);outline-offset:-3px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #1d303d;vertical-align:middle}th{font-size:11px;letter-spacing:.06em;color:var(--muted);font-weight:600}td small{display:block;color:var(--muted);margin-top:3px}.none{color:var(--muted);text-align:center;padding:24px}.meter{height:8px;width:112px;background:#192c39;margin-bottom:5px}.meter i{display:block;height:100%;background:var(--cyan)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.event{font-weight:700;text-transform:uppercase;font-size:11px}.rotation_75,.entry{color:var(--cyan)}.force_close_4h{color:var(--warn)}.mark_stale,.candidate_rejected{color:var(--bad)}.bottom{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:1050px){.metrics{grid-template-columns:repeat(2,1fr)}.layout,.bottom{grid-template-columns:1fr}.top{gap:8px}.top span:not(.status),.top .version{display:none}}@media(max-width:560px){.metrics{grid-template-columns:1fr}.wrap{padding:9px}.top{padding:0 12px}.brand{font-size:16px}}
  </style></head><body><header class="top"><div class="brand">SOL <b>PAPER</b></div><span>Local trader</span><span class="version">v0.1</span><span>Solana launch trading</span><span id="stream-status" class="stream-status">CONNECTING</span><strong class="status">PAPER EXECUTION ENABLED - LIVE DISABLED</strong></header><main class="wrap"><section class="metrics"><div class="metric"><div class="label">REALIZED PNL</div><div class="value ${summary.realizedPnlSol >= 0 ? 'good' : 'bad'}">${formatSol(summary.realizedPnlSol)}</div><div class="sub">Closed and rotated portions</div></div><div class="metric"><div class="label">UNREALIZED PNL</div><div class="value ${summary.unrealizedPnlSol >= 0 ? 'good' : 'bad'}">${formatSol(summary.unrealizedPnlSol)}</div><div class="sub">Fresh marks only; ${require('./exit_risk').exitRisk(state).unresolved} unresolved</div></div><div class="metric"><div class="label">LARGEST WIN</div><div class="value good">${formatSol(summary.largestWinSol)}</div><div class="sub">${escapeHtml(summary.largestWinSymbol || 'No closed winner yet')}</div></div><div class="metric"><div class="label">OPEN RUNNERS</div><div class="value">${summary.rotatedRunners} / ${summary.openPositions}</div><div class="sub">25% of original position retained</div></div><div class="metric"><div class="label">RPC REQUESTS</div><div class="value">${summary.totalRpcRequests.toLocaleString()}</div><div class="sub">Read-only provider telemetry</div></div></section><section class="layout"><div class="panel"><h2>Positions (paper trading)</h2><div class="table-wrap"><table><thead><tr><th>Mint / symbol</th><th>Market cap USD</th><th>Entry</th><th>Mark</th><th>PnL</th><th>Held</th><th>10m rotation</th><th>Runner</th><th>4h close</th></tr></thead><tbody>${positionRows}</tbody></table></div></div><details class="panel" data-panel-key="source-pipeline" open><summary>Source pipeline</summary><div class="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Age</th><th>Detail</th></tr></thead><tbody>${pipelineRows}</tbody></table></div></details></section><section class="bottom"><div class="panel"><h2>Recent paper events</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Symbol</th><th>Detail</th><th>PnL</th></tr></thead><tbody>${eventRows}</tbody></table></div></div><div class="panel"><h2>RPC / provider usage</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Requests</th><th>Success</th><th>Errors</th><th>Avg ms</th></tr></thead><tbody>${usageRows}</tbody></table></div></div></section></main><script>document.querySelectorAll('details[data-panel-key]').forEach(function(panel){var key='pcp.dashboard.panel.'+panel.dataset.panelKey;var saved=localStorage.getItem(key);if(saved!==null)panel.open=saved==='open';panel.addEventListener('toggle',function(){localStorage.setItem(key,panel.open?'open':'closed')})})</script></body></html>`;
}

const app = express();
function productiveTreasuryPanel(snapshot: any, registry: any): string {
  if (!snapshot) return `<section class="dashboard-view section-stack" data-dashboard-view="productive" hidden><section class="panel"><h2>Productive asset portfolio</h2><div class="none">Waiting for the Solana-wide productive-token registry.</div></section></section>`;
  const coverage = snapshot.coverage || {};
  const allocation = snapshot.allocation || {};
  const pct = (value: any) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'n/a';
  const money = (value: any) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'pending';
  const rows = (snapshot.candidates || []).map((candidate: any) => {
    const market = candidate.market || {};
    const gmgn = market.gmgn || {};
    const gmgnFees = gmgn.fees || {};
    const assets = (candidate.payout?.assets || [])
      .map((asset: any) => `${asset.symbol}${asset.category ? ` (${asset.category})` : ''}`)
      .join(', ') || 'unverified';
    const issues = (candidate.issues || []).join(', ') || 'all gates passed';
    const routes = [...(market.buyRoute || []), ...(market.sellRoute || [])].filter((value: string, index: number, all: string[]) => all.indexOf(value) === index);
    const feeCategories = (gmgnFees.bonusCategories || []).join(', ') || 'none reported';
    return `<tr><td><strong>${escapeHtml(candidate.symbol)}</strong><small>${escapeHtml(candidate.name)}</small><small>${escapeHtml(String(candidate.mint).slice(0, 12))}...</small></td><td>${escapeHtml(candidate.sourceId)}<small>${escapeHtml(candidate.sourceKind)}</small></td><td><strong>${Number(candidate.payout?.completedCycles || 0).toLocaleString()} cycles</strong><small>${Number(candidate.payout?.recordDays || 0).toLocaleString()} record days · receipts ${candidate.payout?.receiptsVerified ? 'verified' : 'pending'}</small></td><td>${escapeHtml(assets)}<small>Holder payout evidence from protocol source</small></td><td>${money(candidate.treasury?.valueUsd)}<small>${Number(candidate.treasury?.totalFeesClaimedSol || 0).toFixed(3)} SOL fees recorded</small></td><td>${money(market.liquidityUsd)}<small>${money(market.volume24hUsd)} / 24h · ${Number(market.holders || 0).toLocaleString()} holders</small><small>${money(market.marketCapUsd)} market cap</small></td><td><strong>${escapeHtml(gmgn.launchpadPlatform || gmgn.launchpad || 'GMGN pending')}</strong><small>${escapeHtml(feeCategories)} · ${Number(gmgnFees.claimedRecipientCount || 0)}/${Number(gmgnFees.recipientCount || 0)} recipients claimed</small><small>${Number(gmgnFees.totalFee || 0).toFixed(3)} total fee · pair ${escapeHtml(gmgn.pool?.quoteSymbol || 'n/a')}</small></td><td>${pct(market.roundTripLossPct)}<small>${escapeHtml(routes.join(' + ') || 'quote unavailable')}</small></td><td><span class="launch-state ${candidate.decision === 'paper_eligible' ? 'bonded' : 'prebond'}">${escapeHtml(candidate.decision)}</span><small>${escapeHtml(issues)}</small></td><td>${pct(candidate.targetWeightPct)}<small>paper target only</small></td></tr>`;
  }).join('');
  const sourceRows = (snapshot.sources || []).map((source: any) => `<tr><td>${escapeHtml(source.sourceId)}</td><td>${escapeHtml(source.sourceKind)}</td><td><span class="dot ${statusTone(source.status)}"></span>${escapeHtml(source.status)}</td><td>${source.observedAt ? formatAge(Date.now() - source.observedAt) : 'n/a'}</td><td>${escapeHtml(source.detail || '')}</td></tr>`).join('');
  const launchpadRows = (registry?.launchpads || []).map((launchpad: any) => `<tr><td><strong>${escapeHtml(launchpad.name)}</strong><small>${escapeHtml(launchpad.id)}</small></td><td>${escapeHtml((launchpad.venues || []).join(', '))}</td><td>${escapeHtml(launchpad.model)}</td><td>${escapeHtml(launchpad.holderPayout)}</td><td><span class="launch-state ${launchpad.discoveryState === 'live' ? 'bonded' : launchpad.discoveryState === 'unavailable' ? 'prebond' : 'signal'}">${escapeHtml(launchpad.discoveryState || launchpad.discoveryPriority)}</span><small>${escapeHtml(launchpad.discoveryDetail || '')}</small></td></tr>`).join('');
  return `<section class="dashboard-view section-stack" data-dashboard-view="productive" hidden><details class="panel productive" data-panel-key="productive-treasury" open><summary>Productive asset portfolio</summary><dl class="scout-grid treasury-grid"><div><dt>Source coverage</dt><dd>${Number(coverage.freshSources || 0)} / ${Number(coverage.configuredSources || 0)}</dd></div><div><dt>Candidates</dt><dd>${Number(coverage.candidates || 0)}</dd></div><div><dt>Crypto payout lane</dt><dd>${Number(coverage.cryptoPayoutCandidates || 0)}</dd></div><div><dt>Paper eligible</dt><dd>${Number(coverage.eligible || 0)}</dd></div><div><dt>Launchpad families</dt><dd>${Number(registry?.launchpads?.length || 0)}</dd></div><div><dt>Productive budget</dt><dd>${pct(allocation.productiveTokenBudgetPct)}</dd></div><div><dt>Reserve floor</dt><dd>${pct(allocation.reserveFloorPct)}</dd></div><div><dt>Execution</dt><dd>DISABLED</dd></div></dl><div class="treasury-note">GMGN supplies normalized market, fee, launchpad, pool, holder-risk, activity, and social metadata. Holder distributions still require protocol or on-chain payout evidence.</div><div class="treasury-note">${escapeHtml(allocation.note || '')}</div><div class="table-wrap"><table><thead><tr><th>Productive token</th><th>Discovery source</th><th>Payout record</th><th>Distribution assets</th><th>Recorded treasury</th><th>Market depth</th><th>GMGN intelligence</th><th>Round trip</th><th>Admission</th><th>Target</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="none">No verified productive-token candidates yet.</td></tr>'}</tbody></table></div><details data-panel-key="productive-sources"><summary>Connected ecosystem sources</summary><div class="table-wrap"><table><thead><tr><th>Source</th><th>Adapter</th><th>Status</th><th>Age</th><th>Coverage</th></tr></thead><tbody>${sourceRows || '<tr><td colspan="5" class="none">No source adapters reported.</td></tr>'}</tbody></table></div></details><details data-panel-key="productive-launchpads"><summary>Launchpad universe</summary><div class="treasury-note">Discovery coverage only. A venue label never substitutes for verified payout receipts and independent market evidence.</div><div class="table-wrap"><table><thead><tr><th>Platform</th><th>Venue</th><th>Mechanism</th><th>Holder payout</th><th>Priority</th></tr></thead><tbody>${launchpadRows || '<tr><td colspan="5" class="none">No launchpad registry loaded.</td></tr>'}</tbody></table></div></details></details></section>`;
}
function exitPanel(state: any): string {
  if (!state) return '';
  const risk = require('./exit_risk').exitRisk(state);
  const now = Date.now();
  const rows = state.positions.filter((p: any) => p.closedAt === null).map((p: any) => {
    const h = p.exitHealth || {}, pending = p.exitPending;
    const fresh = isFreshMark(state.marksByMint[p.mint], now);
    const errors = (h.providers || []).map((r: any) => `${r.source}: ${r.reason} ${JSON.stringify(r.diagnostic?.body || {})}`).join('; ');
    return `<tr><td>${escapeHtml(p.symbol)}</td><td>${pending ? escapeHtml(pending.reason) : 'Monitoring'}<small>${pending ? `${formatAge(now - pending.triggeredAt)} since trigger` : ''}</small></td><td>${fresh ? 'Fresh quote' : 'BLOCKED / stale'}<small>${escapeHtml(h.source || 'No verified source')}</small></td><td>${h.lastSuccessAt ? `${formatAge(now - h.lastSuccessAt)} ago` : 'Unknown'}</td><td>${h.nextRetryAt > now ? `${Math.ceil((h.nextRetryAt - now) / 1000)}s` : 'Due'}</td><td style="max-width:420px;overflow-wrap:anywhere">${escapeHtml(h.status === 'blocked' ? errors || h.reason : '')}</td></tr>`;
  }).join('');
  return `<section class="dashboard-view section-stack" data-dashboard-view="overview"><details class="panel" data-panel-key="exit-reliability"><summary>Exit reliability · ${risk.unresolved} unresolved</summary><div class="risk-strip"><span>Stress equity <strong>${formatSol(risk.stressEquity)}</strong></span><span>Stress PnL <strong>${formatSol(risk.stressPnl)}</strong></span><span>Unresolved cost <strong>${formatSol(risk.unresolvedCost)}</strong></span></div><div class="table-wrap"><table><thead><tr><th>Position</th><th>Exit trigger</th><th>Quote status</th><th>Last success</th><th>Next retry</th><th>Error</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="none">No open positions.</td></tr>'}</tbody></table></div></details></section>`;
}
function ledgerPanel(state: any): string {
  if (!state) return '';
  const positions = [...(state.positions || [])].sort((a: any, b: any) => Number(b.openedAt || 0) - Number(a.openedAt || 0));
  const closed = positions.filter((position: any) => position.closedAt !== null);
  const wins = closed.filter((position: any) => Number(position.realizedPnlSol || 0) > 0).length;
  const winRate = closed.length ? `${((wins / closed.length) * 100).toFixed(1)}%` : 'n/a';
  const rows = positions.map((position: any) => {
    const realized = Number(position.realizedPnlSol || 0);
    const capital = Number(position.originalCapitalSol || 0);
    const returnPct = capital > 0 ? (realized / capital) * 100 : null;
    const status = position.closedAt !== null ? 'closed' : position.exitPending ? 'exit pending' : 'open';
    const heldUntil = Number(position.closedAt || Date.now());
    const heldMs = Math.max(0, heldUntil - Number(position.openedAt || heldUntil));
    const entryMode = position.evidence?.entryMode || position.evidence?.pattern?.lane || position.evidence?.discovery?.pattern?.name || 'unclassified';
    const proceeds = position.closedAt !== null ? capital + realized : null;
    return `<tr><td><strong>${escapeHtml(position.symbol || 'Unknown')}</strong><small class="ledger-mint">${escapeHtml(position.mint)}</small></td><td><span class="launch-state ${status === 'closed' ? 'bonded' : status === 'exit pending' ? 'prebond' : 'signal'}">${escapeHtml(status)}</span><small>${escapeHtml(position.closeReason || 'monitoring')}</small></td><td>${escapeHtml(entryMode)}</td><td>${new Date(position.openedAt).toLocaleString()}<small>${position.closedAt ? `Closed ${new Date(position.closedAt).toLocaleString()}` : 'Still open'}</small></td><td>${capital.toFixed(5)} SOL<small>${Number(position.originalTokenAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} tokens</small></td><td>${Number(position.entryPriceSol || 0).toFixed(9)} SOL<small>${proceeds === null ? 'Awaiting close' : `${proceeds.toFixed(6)} SOL net proceeds`}</small></td><td class="${realized >= 0 ? 'good' : 'bad'}"><strong>${formatSol(realized)}</strong><small>${returnPct === null ? 'n/a' : `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`}</small></td><td>${formatAge(heldMs)}<small>${position.exitDelayMs == null ? 'No exit delay recorded' : `${Math.round(Number(position.exitDelayMs) / 1000)}s exit delay`}</small></td><td>${escapeHtml(position.closeReason || position.exitPending?.reason || '---')}</td></tr>`;
  }).join('');
  const cumulative = positions.reduce((sum: number, position: any) => sum + Number(position.realizedPnlSol || 0), 0);
  return `<section class="dashboard-view section-stack" data-dashboard-view="ledger" hidden><section class="panel ledger"><h2>Active-run paper trade ledger</h2><div class="risk-strip"><span>Records<strong>${positions.length}</strong></span><span>Closed<strong>${closed.length}</strong></span><span>Win rate<strong>${winRate}</strong></span><span>Net realized<strong class="${cumulative >= 0 ? 'good' : 'bad'}">${formatSol(cumulative)}</strong></span><span>Policy<strong>TP ${Number(state.config?.takeProfitPct || 0)}% · SL ${Number(state.config?.stopLossPct || 0)}%</strong></span></div><div class="treasury-note">Current run only. Funding changes are excluded from PnL; the preserved pre-reset archive is not mixed into this ledger.</div><div class="table-wrap"><table><thead><tr><th>Token / mint</th><th>Status</th><th>Entry mode</th><th>Lifecycle</th><th>Capital</th><th>Entry / proceeds</th><th>Net PnL</th><th>Held</th><th>Exit reason</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="none">No paper trades recorded in the active run.</td></tr>'}</tbody></table></div></section></section>`;
}
function livePanel(state: any): string {
  const live = state?.live;
  if (!live) return '';
  const age = Date.now() - (live.heartbeat || 0);
  const status = age > 60000 ? 'stale' : live.status;
  const usage = live.usage || {};
  const evidence = (d: any) => {
    if (!d) return '<small>Evidence pending</small>';
    const value = (v: any) => v === null || v === undefined ? 'unknown' : escapeHtml(String(v));
    const pct = (v: any) => v === null || v === undefined ? 'unknown' : `${(v * 100).toFixed(2)}%`;
    const checks = Object.entries(d.checks || {});
    const passed = checks.filter(([, row]: any) => row.status === 'pass').length;
    const warnings = checks.filter(([, row]: any) => row.status === 'warn').map(([name]) => name);
    return `<details><summary>Discovery evidence</summary><div style="max-width:420px;overflow-wrap:anywhere;white-space:normal">
      <small>GMGN receipt: ${formatAge(Date.now() - d.observedAt)} ago</small>
      <small>${value(d.identity?.name)} · ${value(d.migration?.platform)} · ${Number(d.migration?.status) === 1 ? 'bonded' : 'pre-bond'} · ${value(d.ageSeconds)}s old</small>
      <small>Market cap: ${escapeHtml(require('./market_cap').marketCapLabel(displayMarketCap(d)))}${require('./market_cap').marketCapSecondaryLabel(displayMarketCap(d)) ? ` | ${escapeHtml(require('./market_cap').marketCapSecondaryLabel(displayMarketCap(d)))}` : ''} | Holders: ${value(d.holderCount)}</small>
      <small>Liquidity: $${value(d.liquidityUsd)} | Top 10: ${pct(d.concentration?.top10)}</small>
      <small>Supply control: monitored ${pct(d.supplyControl?.monitoredControllerRatio)} | market maker ${pct(d.supplyControl?.knownMarketMakerRatio)} | pool ${pct(d.supplyControl?.verifiedLiquidityPoolRatio)} | unattributed ${pct(d.supplyControl?.unattributedTop10Ratio)}</small>
      <small>Supply profile: ${value(d.supplyControl?.profile?.id || 'none')} | RPC attribution: ${value(d.supplyControl?.accountVerification || d.supplyControl?.status || 'not required')}</small>
      <small>Creator: ${pct(d.concentration?.creator)} | Bundlers: ${pct(d.concentration?.bundler)} | Insiders: ${pct(d.concentration?.insider)}</small>
      <small>1m buys / sells: ${value(d.flow?.buys1m)} / ${value(d.flow?.sells1m)} | Volume: $${value(d.flow?.volume1mUsd)}</small>
      <small>5m / 1h volume: $${value(d.flow?.windows?.['5m']?.volumeUsd)} / $${value(d.flow?.windows?.['1h']?.volumeUsd)}</small>
      <small>Supply circulating / total / max: ${value(d.supply?.circulating)} / ${value(d.supply?.total)} / ${value(d.supply?.max)}</small>
      <small>Wallet tags: smart ${value(d.walletTags?.smart_wallets)} · fresh ${value(d.walletTags?.fresh_wallets)} · whale ${value(d.walletTags?.whale_wallets)} · sniper ${value(d.walletTags?.sniper_wallets)}</small>
      <small>Mint / freeze renounced: ${value(d.security?.mintRenounced)} / ${value(d.security?.freezeRenounced)} | Flags: ${value(d.security?.flags?.join(', ') || 'none reported')}</small>
      <small>Free derived checks: ${passed}/${checks.length} pass${warnings.length ? ` | Warnings: ${escapeHtml(warnings.join(', '))}` : ''}</small>
      <small>Vault balances: ${d.reserves ? `confirmed via ${value(d.reserves.rpcProvider)}` : 'unavailable'} | Pool layout: not decoded</small>
      <small>GMGN candles: ${value(d.candles?.historyStatus)} | Independent OHLC: unavailable</small>
      <small>Issues: ${value(d.issues?.join(', ') || 'none in checked fields')}</small>
      <small><a href="/api/evidence/${encodeURIComponent(d.mint)}" target="_blank" rel="noopener">Open complete GMGN evidence</a></small>
      </div></details>`;
  };
  const rows = (live.candidates || []).map((r: any) => `<tr><td>${escapeHtml(r.symbol)}<small>${escapeHtml(r.mint)}</small>${evidence(r.discovery)}</td><td>${escapeHtml(r.source)}</td><td>${escapeHtml(r.decision)}</td><td>${escapeHtml(r.reason)}</td><td>${formatAge(Date.now() - r.discoveredAt)}</td></tr>`).join('');
  return `<section class="dashboard-view section-stack" data-dashboard-view="system" hidden><section class="panel"><h2>Worker process</h2><div class="worker-strip"><span>Status <strong class="${status === 'running' ? 'good' : 'warn'}">${escapeHtml(status)}</strong></span><span>Heartbeat <strong>${Math.round(age / 1000)}s ago</strong></span><span>Helius estimate <strong>${Number(usage.estimatedCredits || 0).toLocaleString()} / ${Number(usage.monthlyCap || 9000000).toLocaleString()}</strong></span><span>Available <strong>${Number(state.availableCapitalSol).toFixed(5)} SOL</strong></span></div></section></section><section class="dashboard-view section-stack" data-dashboard-view="scout" hidden>${scoutingPanel(state)}<details class="panel" data-panel-key="mints-pipeline" open><summary>Mints in pipeline</summary><div class="table-wrap"><table><thead><tr><th>Mint</th><th>Source</th><th>Stage</th><th>Reason</th><th>Observed</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="none">Waiting for discovery.</td></tr>'}</tbody></table></div></details></section>`;
}
function scoutingPanel(state: any): string {
  const policy = state?.live?.entryPolicy || {};
  const minHolders = Number(policy.minHolders || 100);
  const candidates = [...(state?.live?.candidates || [])]
    .filter((row: any) => Number(row.discovery?.holderCount) >= minHolders)
    .sort((a: any, b: any) => Number(Boolean(b.discovery)) - Number(Boolean(a.discovery)) || (b.checkedAt || b.discoveredAt || 0) - (a.checkedAt || a.discoveredAt || 0))
    .slice(0, 20);
  const number = (value: any, digits = 0) => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }) : 'pending';
  const percent = (value: any) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'pending';
  const freshTracked = candidates.filter((row: any) => row.discovery?.entryLane === 'acceleration' || (row.discovery && Number(row.discovery.ageSeconds) < Number(policy.minAgeSeconds || 3600))).length;
  const retracesTracked = candidates.filter((row: any) => row.discovery?.entryLane === 'retrace' || Number(row.discovery?.migration?.status) === 1).length;
  const rows = candidates.map((row: any) => {
    const d = row.discovery, pattern = d?.pattern;
    const marketCapModule = require('./market_cap');
    const normalizedMarketCap = displayMarketCap(d);
    const marketCap = marketCapModule.marketCapLabel(normalizedMarketCap);
    const secondaryMarketCap = marketCapModule.marketCapSecondaryLabel(normalizedMarketCap);
    const regime = d?.entryLane || pattern?.regime || (d?.patternIssue ? 'not confirmed' : 'pending');
    const movement = d?.entryLane === 'acceleration' ? `${percent(pattern?.momentumPct)} momentum` : d?.entryLane === 'retrace' ? `${percent(pattern?.postHypeDrawdownPct)} retrace` : 'pending move';
    const bonded = Number(d?.migration?.status) === 1;
    const bondState = !d ? 'PENDING' : bonded ? 'BONDED' : 'PRE-BOND';
    const checks = Object.values(d?.checks || {}) as any[];
    const passed = checks.filter(check => check.status === 'pass').length;
    const warnings = checks.filter(check => check.status === 'warn').length;
    const unknownChecks = checks.filter(check => check.status === 'unknown').length;
    const reasons = String(row.reason || 'Awaiting evidence').split(', ').filter(Boolean);
    const reasonSummary = `${reasons[0]}${reasons.length > 1 ? ` +${reasons.length - 1} more` : ''}`;
    const symbol = row.symbol || d?.identity?.symbol || 'Unknown';
    const monogram = String(symbol).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    return `<tr><td><div class="launch-token"><span class="token-placeholder">${escapeHtml(monogram)}</span><div><strong>${escapeHtml(symbol)}</strong><small>${escapeHtml(d?.identity?.name || String(row.mint || '').slice(0, 12))}</small><small>${escapeHtml(d?.migration?.platform || row.source)} · ${formatAge(Math.max(0, Date.now() - (d?.createdAt || row.discoveredAt)))}</small></div></div></td><td><span class="launch-state ${!d ? '' : bonded ? 'bonded' : 'prebond'}">${bondState}</span><small>${d ? `${number(d.migration?.progress, 1)}% progress` : 'Awaiting metadata'}</small></td><td><strong>${escapeHtml(marketCap)}</strong><small>${secondaryMarketCap ? `${escapeHtml(secondaryMarketCap)} · ` : ''}$${number(d?.liquidityUsd)} liquidity</small></td><td><strong>${number(d?.holderCount)}</strong><small>Raw top 10 ${percent(d?.concentration?.top10)}</small><small>Monitored ${percent(d?.supplyControl?.monitoredControllerRatio)} · Unattributed ${percent(d?.supplyControl?.unattributedTop10Ratio)}</small></td><td><strong>$${number(d?.flow?.volume1mUsd)}</strong><small>${number(d?.flow?.buys1m)} buys · ${number(d?.flow?.sells1m)} sells</small></td><td><span class="launch-state signal">${escapeHtml(regime)}</span><small>${movement}</small></td><td><strong>${passed}/${checks.length || 0}</strong><small>${warnings} warn · ${unknownChecks} pending</small></td><td>${escapeHtml(row.decision || 'queued')}<small>${escapeHtml(reasonSummary)}</small></td></tr>`;
  }).join('');
  return `<details class="panel scouting launchpad" data-panel-key="scouting" style="margin-top:16px" open><summary>PCP Launchpad</summary><dl class="scout-grid"><div><dt>Pool liquidity</dt><dd>$${number(policy.minLiquidityUsd)}</dd></div><div><dt>Holder minimum</dt><dd>${number(policy.minHolders)}+</dd></div><div><dt>Fresh tracked</dt><dd>${number(freshTracked)}</dd></div><div><dt>Retraces tracked</dt><dd>${number(retracesTracked)}</dd></div><div><dt>Acceleration age</dt><dd>${number(Number(policy.minAccelerationAgeSeconds || 0) / 60)}m+</dd></div><div><dt>Acceleration</dt><dd>${percent(policy.minAccelerationGain)} / ${number(policy.accelerationCandleCount)}m</dd></div><div><dt>Acceleration flow</dt><dd>$${number(policy.minAccelerationVolume1mUsd)} / 1m · ${number(policy.minAccelerationSwaps1m)} swaps</dd></div><div><dt>Retrace age</dt><dd>${number(Number(policy.minAgeSeconds || 0) / 3600, 1)}h+</dd></div><div><dt>Retrace range</dt><dd>${percent(policy.minPostHypeDrawdown)}–${percent(policy.maxPostHypeDrawdown)}</dd></div><div><dt>Floor tests</dt><dd>2 separated clusters</dd></div></dl><div class="table-wrap"><table><thead><tr><th>Launch</th><th>Bond state</th><th>Market</th><th>Holders</th><th>Activity 1m</th><th>Signal</th><th>Checks</th><th>Paper decision</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="none">No candidates meet the ${number(minHolders)}+ holder lens</td></tr>`}</tbody></table></div></details>`;
}
app.get('/api/evidence/:mint', (req, res) => {
  const mint = String(req.params.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'invalid_mint' });
  const file = path.join(path.dirname(STATE_FILE), 'discovery-evidence', `${mint}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'evidence_not_found' });
  res.json(readJson(file, { error: 'invalid_evidence' }));
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'local-paper-dashboard', paperExecution: 'enabled', liveExecution: 'disabled', ts: Date.now() }));
app.get('/api/paper', (_req, res) => res.json(loadSnapshot()));
app.get('/api/productive-treasury', (_req, res) => res.json(readJson(PRODUCTIVE_FILE, { ready: false })));
app.get('/api/productive-launchpads', (_req, res) => res.json(readJson(PRODUCTIVE_LAUNCHPAD_FILE, { ready: false })));
app.get('/api/index', (_req, res) => res.json(dashboardIndex(loadSnapshot())));

function streamClientScript(): string {
  return `<script>(function(){
    var status=document.getElementById('stream-status');
    function bindPanels(){document.querySelectorAll('details[data-panel-key]').forEach(function(panel){if(panel.dataset.streamBound)return;panel.dataset.streamBound='1';var key='pcp.dashboard.panel.'+panel.dataset.panelKey;var saved=localStorage.getItem(key);if(saved!==null)panel.open=saved==='open';panel.addEventListener('toggle',function(){localStorage.setItem(key,panel.open?'open':'closed')})})}
    function selectedView(){return localStorage.getItem('pcp.dashboard.view')||'overview'}
    function applyView(name){document.querySelectorAll('[data-dashboard-view]').forEach(function(section){section.hidden=section.dataset.dashboardView!==name});document.querySelectorAll('[data-view-target]').forEach(function(button){button.setAttribute('aria-selected',String(button.dataset.viewTarget===name))})}
    function bindViews(){document.querySelectorAll('[data-view-target]').forEach(function(button){if(button.dataset.viewBound)return;button.dataset.viewBound='1';button.addEventListener('click',function(){localStorage.setItem('pcp.dashboard.view',button.dataset.viewTarget);applyView(button.dataset.viewTarget)})});applyView(selectedView())}
    function replaceMain(html){var current=document.querySelector('main.wrap');if(!current)return;var states={};current.querySelectorAll('details[data-panel-key]').forEach(function(panel){states[panel.dataset.panelKey]=panel.open});var doc=new DOMParser().parseFromString(html,'text/html');var next=doc.querySelector('main.wrap');if(!next)return;next.querySelectorAll('details[data-panel-key]').forEach(function(panel){if(Object.prototype.hasOwnProperty.call(states,panel.dataset.panelKey))panel.open=states[panel.dataset.panelKey]});current.replaceWith(next);bindPanels();bindViews()}
    bindPanels();bindViews();
    var events=new EventSource('/api/stream');
    events.addEventListener('snapshot',function(event){try{var payload=JSON.parse(event.data);window.pcpIndex=payload.index;replaceMain(payload.mainHtml);if(status){status.textContent='LIVE 1S';status.classList.add('connected')}}catch(error){if(status){status.textContent='STREAM ERROR';status.classList.remove('connected')}}});
    events.onopen=function(){if(status)status.textContent='LIVE 1S'};
    events.onerror=function(){if(status){status.textContent='RECONNECTING';status.classList.remove('connected')}};
  })();</script>`;
}

function renderPage(snapshot: ReturnType<typeof loadSnapshot>, includeClient = true): string {
  let html = render(snapshot)
    .replace('10m rotation', snapshot.state?.config.rotationTrigger === 'inactivity' ? (snapshot.state?.config.inactivityExit === 'full' ? '10m inactivity: full exit' : '10m verified inactivity') : '10m rotation (legacy)')
    .replace('</main>', `${ledgerPanel(snapshot.state)}${productiveTreasuryPanel(snapshot.productive, snapshot.productiveLaunchpads)}${exitPanel(snapshot.state)}${livePanel(snapshot.state)}</main>`)
    .replace('</style>', '.stream-status{font-size:10px;font-weight:800;color:var(--warn);border:1px solid #66552b;padding:4px 7px}.stream-status.connected{color:var(--good);border-color:#235c48}.value{overflow-wrap:anywhere}th{letter-spacing:0}.panel{min-width:0}.table-wrap{max-width:100%}.dashboard-view:not([hidden])~.dashboard-view:not([hidden]){margin-top:10px}.risk-strip,.worker-strip{display:flex;flex-wrap:wrap;gap:10px 22px;padding:12px 14px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px}.risk-strip strong,.worker-strip strong{display:block;margin-top:4px;color:var(--text);font-size:13px}.scout-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:0 15px;border-bottom:1px solid var(--line)}.scout-grid div{padding:13px 8px;border-right:1px solid #273439}.scout-grid div:nth-child(4n){border-right:0}.scout-grid dt{color:var(--muted);font-size:11px;text-transform:uppercase}.scout-grid dd{margin:6px 0 0;font-size:15px;font-weight:800;color:var(--cyan)}.scouting table,.productive table,.ledger table{min-width:1180px}.scouting td:last-child,.productive td:nth-child(8){max-width:360px;overflow-wrap:anywhere}.ledger-mint{max-width:260px;overflow-wrap:anywhere}.ledger tbody tr:hover{background:#1b2021}.treasury-note{padding:12px 15px;color:var(--muted);border-bottom:1px solid var(--line)}.productive>details>summary{cursor:pointer;padding:12px 15px;color:var(--cyan);font-weight:800}.launch-token{display:grid;grid-template-columns:38px minmax(112px,1fr);align-items:center;gap:10px}.launch-token img,.token-placeholder{width:38px;height:38px;border:1px solid var(--line);border-radius:4px;object-fit:cover}.token-placeholder{display:grid;place-items:center;color:var(--muted);background:#111719}.launch-state{display:inline-block;border:1px solid var(--line);border-radius:2px;padding:3px 6px;font-size:10px;font-weight:800;color:var(--muted)}.launch-state.bonded{color:var(--good);border-color:#235c48}.launch-state.prebond{color:var(--warn);border-color:#66552b}.launch-state.signal{color:var(--cyan);border-color:#20576a}.launchpad tbody tr:hover,.productive tbody tr:hover{background:#1b2021}.launchpad a{color:var(--cyan)}@media(max-width:1050px){.scout-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.scout-grid div:nth-child(2n){border-right:0}}@media(max-width:560px){.scout-grid{grid-template-columns:1fr}.scout-grid div{border-right:0}} </style>');
  if (includeClient) html = html.replace('</body>', `${streamClientScript()}</body>`);
  return html;
}

function streamPayload() {
  const snapshot = loadSnapshot();
  const page = renderPage(snapshot, false);
  const mainHtml = page.match(/<main class="wrap">[\s\S]*?<\/main>/)?.[0] || '<main class="wrap"></main>';
  return JSON.stringify({ streamedAt: Date.now(), revision: cachedStateMtime, index: dashboardIndex(snapshot), mainHtml });
}

const streamClients = new Set<any>();
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  streamClients.add(res);
  res.write(`retry: ${STREAM_INTERVAL_MS}\n\nevent: snapshot\ndata: ${streamPayload()}\n\n`);
  req.on('close', () => streamClients.delete(res));
});

setInterval(() => {
  if (!streamClients.size) return;
  const payload = streamPayload();
  for (const client of streamClients) client.write(`event: snapshot\ndata: ${payload}\n\n`);
}, STREAM_INTERVAL_MS).unref();

app.get('/', (_req, res) => {
  const snapshot = loadSnapshot();
  res.type('html').send(renderPage(snapshot));
});
app.listen(PORT, HOST, () => console.log(`[LOCAL-PAPER-DASHBOARD] http://${HOST}:${PORT} | state=${STATE_FILE}`));
