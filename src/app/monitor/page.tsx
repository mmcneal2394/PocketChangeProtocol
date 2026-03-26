"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────────
interface Agent    { name: string; status: string; uptime: number|null; restarts: number; mem_mb: number; }
interface Position { mint: string; ata: string|null; symbol: string; buy_sol: number; token_amount: number; opened_at: number; tp_pct: number; sl_pct: number; peak_pnl_pct: number; }
interface Trade    { symbol: string; mint: string; pnl: number; reason: string; ts: number; }
interface Trending { symbol: string; mint: string; vol1h: number; chg1h: number; chg5m?: number; ratio: number; buys: number; sells: number; mcap: number; source: string; }
interface Finding  { severity: string; category: string; message: string; suggestion: string; }
interface SwarmData {
  ts: number; stale?: boolean; error?: string;
  agents: Agent[];
  portfolio: { trades: number; wins: number; losses: number; wr_pct: number; net_pnl: number; profit_factor: number|string; exits: Record<string,number>; };
  open_positions: Position[];
  blacklist_count: number;
  last_trades: Trade[];
  trending: Trending[];
  allocation: { sniper_weight?: number; pf_weight?: number; arb_weight?: number; reason?: string; };
  findings: Finding[];
  last_optimizer_cycle?: Record<string, unknown> | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const pct  = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const sol  = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(5)} SOL`;
const age  = (ms: number) => { const s = Math.floor((Date.now()-ms)/1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`; };
const fmtVol = (v: number) => v >= 1000000 ? `$${(v/1e6).toFixed(1)}M` : v >= 1000 ? `$${(v/1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
const AGENT_LABELS: Record<string,string> = {
  "jupiter-ultra-bot":"Ultra Bot","pcp-engine":"Engine","pcp-sniper":"Sniper",
  "pcp-pumpfun":"PumpFun","pcp-trending":"Trending","pcp-health":"Health",
  "pcp-strategist":"Strategist","pcp-optimizer":"Optimizer","pcp-social":"Social",
};

// ── Style constants ────────────────────────────────────────────────────────────
const card  = { background:"rgba(20,20,28,0.7)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"16px", padding:"20px", backdropFilter:"blur(20px)" };
const label = { fontSize:"0.72rem", fontWeight:700, textTransform:"uppercase" as const, letterSpacing:"1px", color:"#6b7280" };
const val   = { fontSize:"1.5rem", fontWeight:800, marginTop:"6px" };

// ── Sub-components ─────────────────────────────────────────────────────────────
function AgentPill({ agent }: { agent: Agent }) {
  const online  = agent.status === "online";
  const stopped = agent.status === "stopped";
  const color   = online ? "#10b981" : stopped ? "#6b7280" : "#ef4444";
  const bg      = online ? "rgba(16,185,129,0.12)" : stopped ? "rgba(107,114,128,0.12)" : "rgba(239,68,68,0.12)";
  return (
    <div title={`${agent.status} | ${agent.mem_mb}MB | ${agent.restarts} restarts`}
      style={{ display:"flex", alignItems:"center", gap:"7px", padding:"6px 12px", borderRadius:"8px", background:bg, border:`1px solid ${color}22`, fontSize:"0.78rem", fontWeight:600 }}>
      <span style={{ width:7, height:7, borderRadius:"50%", background:color, boxShadow:`0 0 6px ${color}`, flexShrink:0,
        animation: online ? "pulse 2s infinite" : "none" }} />
      <span style={{ color:"#e5e7eb" }}>{AGENT_LABELS[agent.name] || agent.name}</span>
      {online && <span style={{ color:"#6b7280", fontSize:"0.68rem" }}>{agent.mem_mb}MB</span>}
    </div>
  );
}

function ExitBadge({ reason }: { reason: string }) {
  const r = reason.split(" ")[0];
  const map: Record<string,[string,string]> = { TP:["#10b981","rgba(16,185,129,0.15)"], TRAIL:["#3b82f6","rgba(59,130,246,0.15)"], SL:["#ef4444","rgba(239,68,68,0.15)"], TIME:["#f59e0b","rgba(245,158,11,0.15)"], "orphan-recovery":["#8b5cf6","rgba(139,92,246,0.15)"] };
  const [clr, bg] = map[r] || ["#6b7280","rgba(107,114,128,0.15)"];
  return <span style={{ padding:"2px 8px", borderRadius:"6px", background:bg, color:clr, fontSize:"0.7rem", fontWeight:700 }}>{r}</span>;
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function MonitorPage() {
  const [data, setData]       = useState<SwarmData | null>(null);
  const [lastFetch, setFetch] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch("/api/swarm", { cache:"no-store" });
      const d = await r.json();
      setData(d);
      setFetch(Date.now());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);

  const p = data?.portfolio;
  const testStart = data?.last_optimizer_cycle as any;

  return (
    <div style={{ minHeight:"100vh", background:"#080810", color:"#fff", fontFamily:"Inter,-apple-system,sans-serif", padding:"0" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        .row-hover:hover { background:rgba(255,255,255,0.04)!important; }
      `}</style>

      {/* ── Header ── */}
      <header style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"16px 28px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"rgba(8,8,16,0.9)", backdropFilter:"blur(12px)", position:"sticky", top:0, zIndex:50 }}>
        <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
          <Link href="/" style={{ display:"flex", alignItems:"center", gap:"10px", textDecoration:"none" }}>
            <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4" alt="PCP" style={{ width:32, height:32, borderRadius:"8px" }} />
            <span style={{ fontSize:"1rem", fontWeight:800, color:"#fff" }}>PocketChange</span>
          </Link>
          <span style={{ color:"rgba(255,255,255,0.2)" }}>|</span>
          <span style={{ fontSize:"0.85rem", fontWeight:700, color:"#8b5cf6" }}>⚡ Swarm Monitor</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:"16px" }}>
          {data?.stale && <span style={{ fontSize:"0.75rem", color:"#f59e0b", fontWeight:600 }}>⚠ Stale data</span>}
          {data?.error && <span style={{ fontSize:"0.75rem", color:"#ef4444", fontWeight:600 }}>● Offline</span>}
          {!data?.error && !loading && <span style={{ fontSize:"0.75rem", color:"#10b981", fontWeight:600 }}>● Live</span>}
          <span style={{ fontSize:"0.72rem", color:"#6b7280" }}>Refreshes every 15s{lastFetch ? ` · last ${age(lastFetch)} ago` : ""}</span>
          <button onClick={fetchData} style={{ background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:"8px", padding:"6px 14px", color:"#fff", fontSize:"0.78rem", fontWeight:600, cursor:"pointer" }}>↻ Now</button>
        </div>
      </header>

      <div style={{ maxWidth:1400, margin:"0 auto", padding:"24px 28px", display:"flex", flexDirection:"column", gap:"20px" }}>

        {/* ── Agent Status Bar ── */}
        <section style={{ animation:"slideUp 0.4s ease" }}>
          <p style={label}>Agent Health</p>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"8px", marginTop:"10px" }}>
            {loading ? <span style={{ color:"#6b7280", fontSize:"0.85rem" }}>Connecting to swarm…</span>
              : (data?.agents || []).map(a => <AgentPill key={a.name} agent={a} />)}
          </div>
        </section>

        {/* ── Portfolio Strip ── */}
        <section style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:"12px", animation:"slideUp 0.5s ease" }}>
          {[
            ["Trades",      p?.trades ?? "–"],
            ["Win Rate",    p ? `${p.wr_pct}%` : "–"],
            ["Net PnL",     p ? sol(p.net_pnl) : "–"],
            ["Profit Factor", p?.profit_factor ?? "–"],
            ["Open Positions", data?.open_positions?.length ?? "–"],
            ["Blacklisted", data?.blacklist_count ?? "–"],
          ].map(([k, v]) => (
            <div key={k as string} style={card}>
              <p style={label}>{k}</p>
              <p style={{ ...val, fontSize:"1.3rem", color: k==="Net PnL" ? ((p?.net_pnl||0)>=0?"#10b981":"#ef4444") : "#fff" }}>{v as string}</p>
            </div>
          ))}
        </section>

        {/* ── Exit Breakdown ── */}
        {p?.exits && Object.keys(p.exits).length > 0 && (
          <section style={{ ...card, padding:"16px 20px", display:"flex", gap:"20px", alignItems:"center", flexWrap:"wrap" }}>
            <span style={{ ...label, marginBottom:0 }}>Exit Mix</span>
            {Object.entries(p.exits).map(([k,v]) => {
              const colors: Record<string,string> = { TP:"#10b981", TRAIL:"#3b82f6", SL:"#ef4444", TIME:"#f59e0b" };
              return <span key={k} style={{ fontSize:"0.85rem", fontWeight:700, color: colors[k]||"#9ca3af" }}>{k} <span style={{ fontWeight:400, color:"#6b7280" }}>×{v}</span></span>;
            })}
          </section>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"20px" }}>

          {/* ── Open Positions ── */}
          <section style={{ ...card }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"14px" }}>
              <p style={label}>Open Positions ({data?.open_positions?.length ?? 0} / 10)</p>
            </div>
            {(!data?.open_positions || data.open_positions.length === 0) ? (
              <p style={{ color:"#6b7280", fontSize:"0.85rem", textAlign:"center", padding:"20px 0" }}>No open positions — scanning…</p>
            ) : data.open_positions.map((pos, i) => (
              <div key={pos.mint} className="row-hover" style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 6px", borderBottom: i < data.open_positions.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none", borderRadius:"8px", transition:"background 0.2s" }}>
                <div>
                  <span style={{ fontWeight:700, fontSize:"0.9rem" }}>{pos.symbol}</span>
                  <span style={{ color:"#6b7280", fontSize:"0.7rem", marginLeft:"8px" }}>{age(pos.opened_at)} ago</span>
                  {pos.ata && (
                    <a href={`https://solscan.io/account/${pos.ata}`} target="_blank" rel="noopener noreferrer"
                      style={{ display:"block", color:"#6b7280", fontSize:"0.68rem", fontFamily:"monospace", marginTop:"2px", textDecoration:"none" }}>
                      {pos.ata.slice(0,12)}…
                    </a>
                  )}
                </div>
                <div style={{ textAlign:"right" }}>
                  <p style={{ fontSize:"0.78rem", color:"#10b981", fontWeight:600 }}>TP +{pos.tp_pct}% · SL -{pos.sl_pct}%</p>
                  {pos.peak_pnl_pct > 0 && <p style={{ fontSize:"0.7rem", color:"#3b82f6" }}>Peak +{pos.peak_pnl_pct.toFixed(1)}%</p>}
                </div>
              </div>
            ))}
          </section>

          {/* ── Trade Feed ── */}
          <section style={{ ...card }}>
            <p style={{ ...label, marginBottom:"14px" }}>Recent Exits</p>
            {(!data?.last_trades || data.last_trades.length === 0)
              ? <p style={{ color:"#6b7280", fontSize:"0.85rem", textAlign:"center", padding:"20px 0" }}>No trades yet</p>
              : (data.last_trades).map((t, i) => (
                <div key={i} className="row-hover" style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 6px", borderBottom: i < data.last_trades.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none", borderRadius:"8px", transition:"background 0.2s" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
                    <ExitBadge reason={t.reason}/>
                    <span style={{ fontWeight:600, fontSize:"0.88rem" }}>{t.symbol}</span>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <span style={{ fontWeight:700, fontSize:"0.9rem", color:(t.pnl||0)>=0?"#10b981":"#ef4444" }}>{sol(t.pnl||0)}</span>
                    <p style={{ color:"#6b7280", fontSize:"0.68rem", marginTop:"2px" }}>{t.ts ? age(t.ts) + " ago" : ""}</p>
                  </div>
                </div>
              ))
            }
          </section>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"20px" }}>

          {/* ── Trending Feed ── */}
          <section style={{ ...card }}>
            <p style={{ ...label, marginBottom:"14px" }}>Live Trending Feed</p>
            {(!data?.trending || data.trending.length === 0)
              ? <p style={{ color:"#6b7280", fontSize:"0.85rem", textAlign:"center", padding:"20px 0" }}>Waiting for trending data…</p>
              : data.trending.map((t, i) => (
                <div key={t.mint} className="row-hover" style={{ display:"grid", gridTemplateColumns:"1fr auto", alignItems:"center", gap:"8px", padding:"9px 6px", borderBottom: i < data.trending.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none", borderRadius:"8px", transition:"background 0.2s" }}>
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
                      <span style={{ fontWeight:700, fontSize:"0.9rem" }}>{t.symbol}</span>
                      <span style={{ fontSize:"0.68rem", color:"#6b7280", background:"rgba(255,255,255,0.05)", padding:"1px 6px", borderRadius:"4px" }}>{t.source?.split("-")[1] || t.source}</span>
                    </div>
                    <span style={{ color:"#6b7280", fontSize:"0.7rem" }}>{fmtVol(t.vol1h)} vol · {t.buys}B/{t.sells}S ({t.ratio?.toFixed(1)}x)</span>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <p style={{ fontWeight:700, fontSize:"0.88rem", color:t.chg1h>=0?"#10b981":"#ef4444" }}>{pct(t.chg1h)}/1h</p>
                    {t.chg5m != null && <p style={{ fontSize:"0.7rem", color:t.chg5m>=0?"#3b82f6":"#f59e0b" }}>{pct(t.chg5m)}/5m</p>}
                  </div>
                </div>
            ))}
          </section>

          {/* ── Harmony Allocation + Findings ── */}
          <div style={{ display:"flex", flexDirection:"column", gap:"16px" }}>

            {/* Allocation */}
            <div style={{ ...card }}>
              <p style={{ ...label, marginBottom:"14px" }}>Capital Allocation (HarmonyAgent)</p>
              {data?.allocation ? (
                <div style={{ display:"flex", flexDirection:"column", gap:"10px" }}>
                  {[
                    ["Sniper",    (data.allocation.sniper_weight||0)*100, "#8b5cf6"],
                    ["PumpFun",   (data.allocation.pf_weight||0)*100,     "#ec4899"],
                    ["Arbitrage", (data.allocation.arb_weight||0)*100,    "#3b82f6"],
                  ].map(([name, pct, color]) => (
                    <div key={name as string}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"4px" }}>
                        <span style={{ fontSize:"0.8rem", fontWeight:600, color:"#e5e7eb" }}>{name}</span>
                        <span style={{ fontSize:"0.8rem", fontWeight:700, color: color as string }}>{(pct as number).toFixed(0)}%</span>
                      </div>
                      <div style={{ height:6, borderRadius:999, background:"rgba(255,255,255,0.06)" }}>
                        <div style={{ height:"100%", borderRadius:999, background: color as string, width:`${pct}%`, transition:"width 0.8s ease", boxShadow:`0 0 8px ${color}66` }} />
                      </div>
                    </div>
                  ))}
                  {data.allocation.reason && <p style={{ fontSize:"0.7rem", color:"#6b7280", marginTop:"4px" }}>{data.allocation.reason}</p>}
                </div>
              ) : <p style={{ color:"#6b7280", fontSize:"0.82rem" }}>Waiting for HarmonyAgent…</p>}
            </div>

            {/* Analyzer Findings */}
            <div style={{ ...card, flex:1 }}>
              <p style={{ ...label, marginBottom:"12px" }}>Analyzer Findings</p>
              {(!data?.findings || data.findings.length === 0)
                ? <p style={{ color:"#6b7280", fontSize:"0.82rem", textAlign:"center", padding:"16px 0" }}>No findings yet — accumulating data</p>
                : data.findings.slice(0,4).map((f, i) => {
                  const sc: Record<string,string> = { HIGH:"#ef4444", MEDIUM:"#f59e0b", LOW:"#10b981", INFO:"#6b7280" };
                  return (
                    <div key={i} style={{ padding:"10px", borderRadius:"10px", background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.05)", marginBottom:"8px" }}>
                      <div style={{ display:"flex", gap:"8px", alignItems:"center", marginBottom:"4px" }}>
                        <span style={{ fontSize:"0.68rem", fontWeight:700, color:sc[f.severity]||"#6b7280", background:`${sc[f.severity]}22`, padding:"1px 7px", borderRadius:"5px" }}>{f.severity}</span>
                        <span style={{ fontSize:"0.75rem", fontWeight:600, color:"#9ca3af" }}>{f.category}</span>
                      </div>
                      <p style={{ fontSize:"0.78rem", color:"#e5e7eb" }}>{f.message}</p>
                      {f.suggestion && <p style={{ fontSize:"0.72rem", color:"#6b7280", marginTop:"3px" }}>💡 {f.suggestion}</p>}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>

        {/* Footer timestamp */}
        <div style={{ textAlign:"center", color:"#374151", fontSize:"0.72rem", paddingBottom:"20px" }}>
          PocketChange Protocol · Harmonic Swarm Monitor · {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
        </div>
      </div>
    </div>
  );
}
