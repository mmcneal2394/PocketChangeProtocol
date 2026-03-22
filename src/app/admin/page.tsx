"use client";

import { useState, useEffect, useRef } from "react";
import {
  PlayArrow, Stop, Refresh, Settings, TrendingUp, TrendingDown,
  Memory, Speed, AccountBalanceWallet, Warning, CheckCircle,
  PowerSettingsNew, BarChart, AutoGraph, Tune
} from "@mui/icons-material";

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || "pcp-admin-2026";
const ENGINE_URL = "/api/engine";

function StatCard({ label, value, sub, icon, color = "#fff" }: any) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
        <p style={{ color: "#666", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "1px", fontWeight: 600 }}>{label}</p>
        <span style={{ color: "#444" }}>{icon}</span>
      </div>
      <p style={{ fontSize: "1.8rem", fontWeight: 800, color }}>{value}</p>
      {sub && <p style={{ color: "#555", fontSize: "0.8rem", marginTop: "4px" }}>{sub}</p>}
    </div>
  );
}

export default function AdminPanel() {
  const [authed, setAuthed]         = useState(false);
  const [pw, setPw]                 = useState("");
  const [pwError, setPwError]       = useState(false);
  const [stats, setStats]           = useState<any>(null);
  const [logs, setLogs]             = useState<string[]>([]);
  const [engineRunning, setEngineRunning] = useState(false);
  const [tradeSize, setTradeSize]   = useState("0.02");
  const [slippage, setSlippage]     = useState("0.5");
  const [minProfit, setMinProfit]   = useState("0.0001");
  const [jito, setJito]             = useState(true);
  const [tab, setTab]               = useState<"overview"|"logs"|"config">("overview");
  const logsRef = useRef<HTMLDivElement>(null);

  const login = () => {
    if (pw === ADMIN_PASSWORD) { setAuthed(true); setPwError(false); }
    else { setPwError(true); setTimeout(() => setPwError(false), 2000); }
  };

  // Poll engine stats every 3s when authed
  useEffect(() => {
    if (!authed) return;
    const poll = async () => {
      try {
        const r = await fetch(ENGINE_URL);
        const d = await r.json();
        setStats(d);
        setEngineRunning(!d.error && d.scans > 0);
      } catch { setStats(null); }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [authed]);

  // Poll logs
  useEffect(() => {
    if (!authed) return;
    const pollLogs = async () => {
      try {
        const r = await fetch("/api/logs");
        const d = await r.json();
        if (Array.isArray(d)) {
          setLogs(d.slice(0, 20).map((l: any) =>
            `[${new Date().toLocaleTimeString()}] ${l.route || "ENGINE"} · ${l.status} · ${l.profit || "—"}`
          ));
        }
      } catch {}
    };
    pollLogs();
    const id = setInterval(pollLogs, 5000);
    return () => clearInterval(id);
  }, [authed]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const engineAction = async (action: "start" | "stop") => {
    setLogs(prev => [...prev, `[ADMIN] ${action.toUpperCase()} command sent at ${new Date().toLocaleTimeString()}`]);
    // In production: POST to PM2 API or engine control endpoint
    alert(`Engine ${action} command sent. Restart PM2 process "arb-jup" on server to apply.`);
  };

  // ── LOGIN SCREEN ─────────────────────────────────────────────────────────────
  if (!authed) return (
    <div style={{ minHeight: "100vh", background: "#050507", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', sans-serif" }}>
      <div style={{ width: "380px", padding: "48px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "20px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{ width: "60px", height: "60px", borderRadius: "50%", background: "rgba(138,43,226,0.15)", border: "1px solid rgba(138,43,226,0.4)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px auto" }}>
            <PowerSettingsNew style={{ color: "#9b59b6", fontSize: "1.8rem" }} />
          </div>
          <h1 style={{ color: "#fff", fontWeight: 800, fontSize: "1.4rem", marginBottom: "4px" }}>Admin Access</h1>
          <p style={{ color: "#555", fontSize: "0.85rem" }}>PocketChange Engine Control</p>
        </div>
        <div style={{ marginBottom: "16px" }}>
          <label style={{ color: "#666", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "1px", display: "block", marginBottom: "8px" }}>Password</label>
          <input
            type="password"
            value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && login()}
            placeholder="Enter admin password"
            style={{ width: "100%", padding: "14px", background: pwError ? "rgba(255,0,0,0.08)" : "rgba(255,255,255,0.04)", border: `1px solid ${pwError ? "rgba(255,0,0,0.4)" : "rgba(255,255,255,0.1)"}`, borderRadius: "10px", color: "#fff", fontSize: "1rem", outline: "none", boxSizing: "border-box", transition: "all 0.2s" }}
          />
          {pwError && <p style={{ color: "#ff4444", fontSize: "0.8rem", marginTop: "6px" }}>Incorrect password</p>}
        </div>
        <button
          onClick={login}
          style={{ width: "100%", padding: "14px", background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", border: "none", borderRadius: "10px", fontWeight: 700, fontSize: "1rem", cursor: "pointer" }}
        >
          Enter Control Panel →
        </button>
      </div>
    </div>
  );

  // ── ADMIN DASHBOARD ─────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#050507", color: "#fff", fontFamily: "'Inter', sans-serif" }}>
      {/* Top Bar */}
      <header style={{ padding: "16px 32px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.5)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: engineRunning ? "#00ff88" : "#ff4444", boxShadow: `0 0 8px ${engineRunning ? "#00ff88" : "#ff4444"}`, animation: engineRunning ? "pulse 2s infinite" : "none" }} />
          <span style={{ fontWeight: 800, fontSize: "1rem" }}>PocketChange <span style={{ color: "#9b59b6" }}>Admin</span></span>
          <span style={{ background: "rgba(138,43,226,0.15)", border: "1px solid rgba(138,43,226,0.3)", color: "#9b59b6", padding: "2px 10px", borderRadius: "20px", fontSize: "0.75rem", fontWeight: 600 }}>
            MASTER CONTROL
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => engineAction("start")} style={{ background: "rgba(0,255,136,0.1)", border: "1px solid rgba(0,255,136,0.3)", color: "#00ff88", padding: "8px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
            <PlayArrow fontSize="small" /> START
          </button>
          <button onClick={() => engineAction("stop")} style={{ background: "rgba(255,68,68,0.08)", border: "1px solid rgba(255,68,68,0.3)", color: "#ff4444", padding: "8px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
            <Stop fontSize="small" /> STOP
          </button>
          <button onClick={() => setAuthed(false)} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#666", padding: "8px 14px", borderRadius: "8px", cursor: "pointer", fontSize: "0.85rem" }}>
            Logout
          </button>
        </div>
      </header>

      <div style={{ padding: "32px", maxWidth: "1200px", margin: "0 auto" }}>
        {/* Tab Nav */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "32px", background: "rgba(255,255,255,0.03)", padding: "4px", borderRadius: "12px", width: "fit-content", border: "1px solid rgba(255,255,255,0.06)" }}>
          {([["overview", "Overview", <BarChart fontSize="small" />], ["logs", "Live Logs", <AutoGraph fontSize="small" />], ["config", "Strategy Config", <Tune fontSize="small" />]] as const).map(([id, label, icon]) => (
            <button key={id} onClick={() => setTab(id as any)} style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: tab === id ? "rgba(138,43,226,0.2)" : "transparent", color: tab === id ? "#9b59b6" : "#666", fontWeight: tab === id ? 700 : 500, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", transition: "all 0.2s" }}>
              {icon} {label}
            </button>
          ))}
        </div>

        {/* OVERVIEW TAB */}
        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "32px" }}>
              <StatCard label="Total Scans" value={stats?.scans ?? "—"} sub="All-time market ops" icon={<Speed />} color="#9b59b6" />
              <StatCard label="Trades Executed" value={stats?.trades ?? "0"} sub="Confirmed on-chain" icon={<TrendingUp />} color="#00ff88" />
              <StatCard label="Net PnL" value={stats?.netSol != null ? `+${parseFloat(stats.netSol).toFixed(4)} SOL` : "0.000 SOL"} sub="Cumulative" icon={<AutoGraph />} color="#00ff88" />
              <StatCard label="Engine Status" value={engineRunning ? "LIVE" : "OFFLINE"} sub={engineRunning ? "Processing routes" : "No active scans"} icon={<Memory />} color={engineRunning ? "#00ff88" : "#ff4444"} />
            </div>

            {/* Trade Events */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "24px" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ width: "6px", height: "6px", background: engineRunning ? "#00ff88" : "#666", borderRadius: "50%", display: "inline-block" }} />
                Recent Trade Events
              </h3>
              {stats?.tradeEvents?.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {stats.tradeEvents.slice(0, 8).map((ev: any, i: number) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "rgba(0,0,0,0.3)", borderRadius: "8px", fontSize: "0.85rem" }}>
                      <span style={{ color: "#888", fontFamily: "monospace" }}>{ev.route || "—"}</span>
                      <span style={{ color: ev.ok ? "#00ff88" : "#ff4444", fontWeight: 600 }}>{ev.profit || ev.status || "—"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#444" }}>
                  <Memory style={{ fontSize: "3rem", marginBottom: "12px" }} />
                  <p>No trade events yet — engine needs capital to execute</p>
                  <p style={{ fontSize: "0.85rem", marginTop: "4px" }}>Fund wallet: <span style={{ color: "#9b59b6", fontFamily: "monospace" }}>CDiK12sN2f2EzUGGwNDdGqFzyy3BVLFom4cgE7HQHubz</span></p>
                </div>
              )}
            </div>
          </>
        )}

        {/* LIVE LOGS TAB */}
        {tab === "logs" && (
          <div style={{ background: "#000", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "16px", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ff5f57", display: "inline-block" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#febc2e", display: "inline-block" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#28c840", display: "inline-block" }} />
              <span style={{ color: "#555", fontSize: "0.8rem", marginLeft: "8px" }}>engine-worker · telemetry.jsonl</span>
            </div>
            <div ref={logsRef} style={{ height: "520px", overflowY: "auto", padding: "20px", fontFamily: "monospace", fontSize: "0.8rem", lineHeight: 1.8, color: "#00ff88" }}>
              {logs.length === 0 ? (
                <span style={{ color: "#444" }}>Waiting for engine output... Start the arb engine to see live logs.</span>
              ) : (
                logs.map((l, i) => <div key={i}>{l}</div>)
              )}
            </div>
          </div>
        )}

        {/* STRATEGY CONFIG TAB */}
        {tab === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "600px" }}>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "28px" }}>
              <h3 style={{ fontWeight: 700, marginBottom: "24px", display: "flex", alignItems: "center", gap: "8px" }}>
                <Settings style={{ color: "#9b59b6" }} /> Execution Parameters
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                {[
                  { label: "Trade Size (SOL)", val: tradeSize, set: setTradeSize, hint: "Per-swap capital commitment" },
                  { label: "Max Slippage (%)", val: slippage, set: setSlippage, hint: "Reject routes above this threshold" },
                  { label: "Min Profit Required (SOL)", val: minProfit, set: setMinProfit, hint: "Below this, route is skipped" },
                ].map(f => (
                  <div key={f.label}>
                    <label style={{ color: "#888", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "1px", display: "block", marginBottom: "8px" }}>{f.label}</label>
                    <input
                      type="number"
                      value={f.val}
                      onChange={e => f.set(e.target.value)}
                      style={{ width: "100%", padding: "12px 16px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "10px", color: "#fff", fontSize: "1rem", outline: "none", boxSizing: "border-box" }}
                    />
                    <p style={{ color: "#444", fontSize: "0.78rem", marginTop: "4px" }}>{f.hint}</p>
                  </div>
                ))}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "10px" }}>
                  <div>
                    <p style={{ fontWeight: 600 }}>Jito MEV Protection</p>
                    <p style={{ color: "#666", fontSize: "0.8rem" }}>Routes all bundles via Jito block engine</p>
                  </div>
                  <button onClick={() => setJito(!jito)} style={{ background: jito ? "rgba(0,255,136,0.15)" : "rgba(255,255,255,0.05)", border: `1px solid ${jito ? "rgba(0,255,136,0.4)" : "rgba(255,255,255,0.1)"}`, color: jito ? "#00ff88" : "#666", padding: "8px 20px", borderRadius: "8px", cursor: "pointer", fontWeight: 700 }}>
                    {jito ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={{ padding: "14px 16px", background: "rgba(255,200,0,0.05)", border: "1px solid rgba(255,200,0,0.2)", borderRadius: "10px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
                  <Warning style={{ color: "#ffcc00", fontSize: "1.1rem", marginTop: "2px" }} />
                  <p style={{ color: "#888", fontSize: "0.82rem", lineHeight: 1.6 }}>
                    Config changes take effect on next engine restart. Use START/STOP buttons above.
                    Changes are reflected in <code style={{ color: "#ffcc00" }}>.env</code> — commit to GitHub to persist.
                  </p>
                </div>

                <button style={{ padding: "14px", background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", border: "none", borderRadius: "12px", fontWeight: 700, cursor: "pointer", fontSize: "1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                  <CheckCircle /> Save &amp; Restart Engine
                </button>
              </div>
            </div>

            {/* Wallet info */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "24px" }}>
              <h3 style={{ fontWeight: 700, marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                <AccountBalanceWallet style={{ color: "#9b59b6" }} /> Operator Wallet
              </h3>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#9b59b6", padding: "12px", background: "rgba(0,0,0,0.4)", borderRadius: "8px", wordBreak: "break-all" }}>
                CDiK12sN2f2EzUGGwNDdGqFzyy3BVLFom4cgE7HQHubz
              </div>
              <p style={{ color: "#555", fontSize: "0.8rem", marginTop: "8px" }}>Fund this wallet with SOL to enable live trade execution.</p>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}
