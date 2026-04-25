import express from 'express';
import { buildOverviewSnapshot } from './overview_data';

const HOST = process.env.OVERVIEW_HOST || '127.0.0.1';
const PORT = Number(process.env.OVERVIEW_PORT || 8787);
const REFRESH_SECONDS = Math.max(5, Number(process.env.OVERVIEW_REFRESH_SECONDS || 15));

function formatSol(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)} SOL`;
}

function formatPct(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatRatioPct(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(ts: number | null | undefined) {
  if (!ts) return 'n/a';
  return new Date(ts).toLocaleString();
}

function formatUptime(ms: number | null | undefined) {
  if (!ms) return 'n/a';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusPill(status: string) {
  const tone =
    status === 'online' ? 'good'
      : status === 'stopped' ? 'bad'
        : status === 'waiting restart' ? 'warn'
          : 'neutral';
  return `<span class="pill ${tone}">${escapeHtml(status)}</span>`;
}

function renderOverview(snapshot: any) {
  const pm2Rows = (snapshot.pm2 || [])
    .map((app: any) => `
      <tr>
        <td>${escapeHtml(app.name)}</td>
        <td>${renderStatusPill(app.status)}</td>
        <td>${formatUptime(app.uptimeMs)}</td>
        <td>${app.restarts}</td>
        <td>${app.memoryMb ?? 'n/a'} MB</td>
        <td>${app.cpu ?? 'n/a'}%</td>
      </tr>
    `)
    .join('');

  const positionRows = snapshot.positions.length
    ? snapshot.positions.map((pos: any) => `
        <tr>
          <td>${escapeHtml(pos.symbol)}</td>
          <td>${escapeHtml(pos.entryMode)}</td>
          <td>${formatSol(pos.buyPriceSol)}</td>
          <td>${formatSol(pos.currentValueSol)}</td>
          <td>${formatSol(pos.unrealizedPnlSol)}</td>
          <td>${formatPct(pos.unrealizedPnlPct)}</td>
          <td>${formatPct(pos.peakPnlPct)}</td>
          <td>${pos.heldMinutes.toFixed(1)}m</td>
        </tr>
      `).join('')
    : `<tr><td colspan="8" class="empty">No open positions</td></tr>`;

  const tradeRows = snapshot.recentTrades.length
    ? snapshot.recentTrades.map((trade: any) => `
        <tr>
          <td>${formatTime(trade.ts)}</td>
          <td>${escapeHtml(trade.action)}</td>
          <td>${escapeHtml(trade.symbol)}</td>
          <td>${formatSol(trade.amountSol)}</td>
          <td>${trade.pnlSol === null ? 'n/a' : formatSol(trade.pnlSol)}</td>
          <td>${escapeHtml(trade.reason || '')}</td>
          <td>${escapeHtml(trade.sig || '')}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="7" class="empty">No recent trades</td></tr>`;

  const rejectItems = snapshot.topRejectReasons.length
    ? snapshot.topRejectReasons.map((item: any) => `
        <li><strong>${escapeHtml(item.reason)}</strong> <span>${item.count}</span> <em>${escapeHtml(item.lastSymbol || 'n/a')}</em></li>
      `).join('')
    : `<li class="empty">No reject telemetry yet</li>`;

  const hydrationItems = snapshot.velocityHydration.topMisses.length
    ? snapshot.velocityHydration.topMisses.map((item: any) => `
        <li><strong>${escapeHtml(item.key)}</strong> <span>${item.count}</span> <em>${escapeHtml(item.lastSymbol || 'n/a')}</em></li>
      `).join('')
    : `<li class="empty">No hydration misses recorded</li>`;

  const walletItems = snapshot.walletIntel.topBuySignals.length
    ? snapshot.walletIntel.topBuySignals.map((item: any) => `
        <li><strong>${escapeHtml(item.symbol)}</strong> <span>${escapeHtml(item.conviction || 'n/a')}</span> <em>${item.sizeUp ? 'size-up' : 'normal'}</em></li>
      `).join('')
    : `<li class="empty">No active wallet-led buy signals</li>`;
  const guardianItems = (snapshot.guardian?.anomalies || []).length
    ? snapshot.guardian.anomalies.map((item: any) => `
        <li><strong>${escapeHtml(item.type)}</strong> <span>${escapeHtml(item.severity || 'info')}</span> <em>${escapeHtml(item.evidence?.service || item.evidence?.feed || item.evidence?.scriptPath || 'global')}</em></li>
      `).join('')
    : `<li class="empty">No active guardian anomalies</li>`;

  const bucketRows = (snapshot.learning.bestWorstBuckets || [])
    .map((row: any) => `
      <tr>
        <td>${escapeHtml(row.dimension)}</td>
        <td>${escapeHtml(row.best.bucket)} (${row.best.trades} trades, ${formatRatioPct(row.best.winRate)})</td>
        <td>${escapeHtml(row.worst.bucket)} (${row.worst.trades} trades, ${formatRatioPct(row.worst.winRate)})</td>
      </tr>
    `)
    .join('');

  const gemmaItems = (snapshot.learning.latestGemma.recommendations || []).length
    ? snapshot.learning.latestGemma.recommendations.map((item: any) => `<li>${escapeHtml(item)}</li>`).join('')
    : `<li class="empty">No recent Gemma recommendations</li>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="${REFRESH_SECONDS}" />
    <title>PCP Overview</title>
    <style>
      :root {
        --bg: #09111a;
        --panel: #0f1c28;
        --panel-2: #132535;
        --text: #e7f1f7;
        --muted: #90a8b7;
        --good: #5dd39e;
        --warn: #f7b955;
        --bad: #ff7b72;
        --accent: #69d2e7;
        --line: rgba(255,255,255,0.09);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(105, 210, 231, 0.12), transparent 34%),
          radial-gradient(circle at top right, rgba(247, 185, 85, 0.12), transparent 26%),
          linear-gradient(180deg, #071019 0%, var(--bg) 100%);
      }
      .wrap {
        max-width: 1400px;
        margin: 0 auto;
        padding: 28px;
      }
      .hero {
        display: grid;
        grid-template-columns: 1.5fr 1fr;
        gap: 18px;
        margin-bottom: 18px;
      }
      .panel {
        background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 12px 30px rgba(0,0,0,0.18);
      }
      .headline {
        font-size: 34px;
        font-weight: 700;
        letter-spacing: -0.03em;
        margin: 0 0 8px;
      }
      .sub {
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 16px;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        font-size: 28px;
        font-weight: 700;
        margin-top: 6px;
      }
      .meta {
        margin-top: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.25fr 1fr;
        gap: 18px;
        margin-bottom: 18px;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      h2 {
        margin: 0 0 14px;
        font-size: 16px;
        letter-spacing: 0.01em;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      th, td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
      }
      th {
        color: var(--muted);
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 10px;
      }
      li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        padding: 10px 12px;
        border-radius: 12px;
        background: var(--panel-2);
      }
      li span {
        color: var(--accent);
      }
      li em {
        color: var(--muted);
        font-style: normal;
      }
      .pill {
        display: inline-block;
        padding: 4px 9px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }
      .pill.good { background: rgba(93, 211, 158, 0.14); color: var(--good); }
      .pill.warn { background: rgba(247, 185, 85, 0.14); color: var(--warn); }
      .pill.bad { background: rgba(255, 123, 114, 0.14); color: var(--bad); }
      .pill.neutral { background: rgba(144, 168, 183, 0.14); color: var(--muted); }
      .good { color: var(--good); }
      .bad { color: var(--bad); }
      .empty { color: var(--muted); }
      .kicker {
        display: inline-block;
        margin-bottom: 10px;
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      @media (max-width: 1100px) {
        .hero, .grid, .cards { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <div class="panel">
          <div class="kicker">Live Swarm Overview</div>
          <h1 class="headline">Trading overview for the 24-hour test window.</h1>
          <div class="sub">
            Last refresh ${escapeHtml(formatTime(snapshot.generatedAt))}. Auto-refresh every ${REFRESH_SECONDS}s.
            Open positions: ${snapshot.session.openPositions}. Pause state: ${snapshot.session.pausedUntil ? formatTime(snapshot.session.pausedUntil) : 'active'}.
            Quota assist level: ${snapshot.quota?.quotaAssistLevel ?? 0}.
          </div>
        </div>
        <div class="panel">
          <h2>Learning Snapshot</h2>
          <div class="sub">
            Closed trades in last 24h: <strong>${snapshot.learning.last24h.trades}</strong>,
            win rate <strong>${formatRatioPct(snapshot.learning.last24h.winRate)}</strong>,
            realized <strong>${formatSol(snapshot.learning.last24h.totalPnlSol)}</strong>.
          </div>
          <div class="meta">
            Gemma refresh: ${escapeHtml(snapshot.learning.latestGemma.generatedAt || 'n/a')} |
            profile events ${formatUptime(snapshot.learning.profileFreshness?.eventsAgeMs)} old |
            stats ${formatUptime(snapshot.learning.profileFreshness?.statsAgeMs)} old
          </div>
        </div>
      </section>

      <section class="cards">
        <div class="card">
          <div class="label">Session PnL</div>
          <div class="value ${snapshot.session.totalPnlSol >= 0 ? 'good' : 'bad'}">${formatSol(snapshot.session.totalPnlSol)}</div>
          <div class="meta">Realized this session</div>
        </div>
        <div class="card">
          <div class="label">Open Unrealized</div>
          <div class="value ${snapshot.session.openUnrealizedPnlSol >= 0 ? 'good' : 'bad'}">${formatSol(snapshot.session.openUnrealizedPnlSol)}</div>
          <div class="meta">Across open positions</div>
        </div>
        <div class="card">
          <div class="label">Wins / Losses</div>
          <div class="value">${snapshot.session.wins} / ${snapshot.session.losses}</div>
          <div class="meta">Live session store</div>
        </div>
        <div class="card">
          <div class="label">Wallet Intel</div>
          <div class="value">${snapshot.walletIntel.buySignalCount} / ${snapshot.walletIntel.sellSignalCount}</div>
          <div class="meta">
            ${snapshot.walletIntel.trackedWalletCount} tracked wallets |
            ${snapshot.walletIntel.executableBuySignalCount} executable |
            age ${formatUptime(snapshot.walletIntel.ageMs)}
          </div>
        </div>
        <div class="card">
          <div class="label">Quota Fill</div>
          <div class="value">L${snapshot.quota?.quotaAssistLevel ?? 0}</div>
          <div class="meta">${snapshot.quota?.openPositions ?? 0}/${snapshot.quota?.targetPositions ?? 15} open | shortfall ${snapshot.quota?.shortfall ?? 0}</div>
        </div>
        <div class="card">
          <div class="label">Guardian</div>
          <div class="value">${snapshot.guardian?.anomalyCount ?? 0}</div>
          <div class="meta">${snapshot.guardian?.lastRemediation?.action || 'observe'}</div>
        </div>
        <div class="card">
          <div class="label">Velocity Hydration</div>
          <div class="value">${snapshot.velocityHydration.totalMisses}</div>
          <div class="meta">Misses recorded so far</div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Open Positions</h2>
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Mode</th>
                <th>Entry</th>
                <th>Current</th>
                <th>Unrealized</th>
                <th>PnL %</th>
                <th>Peak</th>
                <th>Held</th>
              </tr>
            </thead>
            <tbody>${positionRows}</tbody>
          </table>
        </div>
        <div class="stack">
          <div class="panel">
            <h2>Top Reject Reasons</h2>
            <ul>${rejectItems}</ul>
          </div>
          <div class="panel">
            <h2>Wallet-Led Buy Signals</h2>
            <ul>${walletItems}</ul>
          </div>
          <div class="panel">
            <h2>Guardian Anomalies</h2>
            <ul>${guardianItems}</ul>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Recent Trades</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Symbol</th>
                <th>Amount</th>
                <th>PnL</th>
                <th>Reason</th>
                <th>Sig</th>
              </tr>
            </thead>
            <tbody>${tradeRows}</tbody>
          </table>
        </div>
        <div class="stack">
          <div class="panel">
            <h2>Swarm Health</h2>
            <table>
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Status</th>
                  <th>Uptime</th>
                  <th>Restarts</th>
                  <th>Mem</th>
                  <th>CPU</th>
                </tr>
              </thead>
              <tbody>${pm2Rows}</tbody>
            </table>
          </div>
          <div class="panel">
            <h2>Velocity Hydration Misses</h2>
            <ul>${hydrationItems}</ul>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Learning Buckets</h2>
          <table>
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Best</th>
                <th>Worst</th>
              </tr>
            </thead>
            <tbody>${bucketRows || '<tr><td colspan="3" class="empty">No learned buckets yet</td></tr>'}</tbody>
          </table>
        </div>
        <div class="panel">
          <h2>Latest Gemma Recommendations</h2>
          <ul>${gemmaItems}</ul>
        </div>
      </section>
    </div>
  </body>
</html>`;
}

async function main() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'pcp-overview', ts: Date.now() });
  });

  app.get('/api/overview', async (_req, res) => {
    try {
      const snapshot = await buildOverviewSnapshot();
      res.json(snapshot);
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || 'overview_failed' });
    }
  });

  app.get('/', async (_req, res) => {
    try {
      const snapshot = await buildOverviewSnapshot();
      res.type('html').send(renderOverview(snapshot));
    } catch (error: any) {
      res.status(500).type('html').send(`<pre>overview_failed: ${escapeHtml(error?.message || 'unknown')}</pre>`);
    }
  });

  app.listen(PORT, HOST, () => {
    console.log(`[OVERVIEW] Listening on http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error('[OVERVIEW] Fatal:', error);
  process.exit(1);
});
