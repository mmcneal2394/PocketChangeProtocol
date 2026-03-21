"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { FlashOn, TrendingUp, SwapHoriz, ErrorOutline, Speed, OpenInNew } from "@mui/icons-material";

interface EngineStatus {
  scans: number;
  trades: number;
  profits: number;
  losses: number;
  netSol: number;
  tradeSizeSol: number;
  lastScans: string[];
  tradeEvents: { tx: string; line: string; ts: string }[];
  sniperStatus: string;
  error?: string;
}

const EMPTY: EngineStatus = {
  scans: 0, trades: 0, profits: 0, losses: 0,
  netSol: 0, tradeSizeSol: 0.05,
  lastScans: [], tradeEvents: [], sniperStatus: "Connecting...",
};

function ScanLine({ line }: { line: string }) {
  const isGreen = line.includes("🟢");
  const isYellow = line.includes("🟡");
  const color = isGreen ? "#34d399" : isYellow ? "#fbbf24" : "#64748b";
  return (
    <div style={{ fontFamily: "monospace", fontSize: "0.72rem", padding: "2px 0", color, borderBottom: "1px solid rgba(255,255,255,0.03)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {line}
    </div>
  );
}

function MetricCard({ label, value, sub, color = "#fff", icon }: { label: string; value: string; sub?: string; color?: string; icon: React.ReactNode }) {
  return (
    <div className="glassmorphism" style={{ padding: "20px 24px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "10px" }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: "2rem", fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>{sub}</div>}
    </div>
  );
}

export default function LiveEnginePage() {
  const [status, setStatus] = useState<EngineStatus>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [solPrice, setSolPrice] = useState<number>(140);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      const data: EngineStatus = await res.json();
      setStatus(data);
      setConnected(!data.error);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const iv = setInterval(fetchStatus, 3000);
    // Fetch SOL price from CoinGecko
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")
      .then(r => r.json()).then(d => setSolPrice(d?.solana?.usd ?? 140)).catch(() => {});
    return () => clearInterval(iv);
  }, [fetchStatus]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [status.lastScans]);

  const netUsd = (status.netSol * solPrice).toFixed(2);
  const netColor = status.netSol > 0 ? "#34d399" : status.netSol < 0 ? "#f87171" : "#fff";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", animation: "fadeIn 0.5s ease" }}>

      {/* Header */}
      <header>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "6px", display: "flex", alignItems: "center", gap: "12px" }}>
              <FlashOn style={{ fontSize: "2.5rem", color: connected ? "#34d399" : "#64748b" }} />
              Live Arb Engine
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              Real-time Jupiter Ultra arbitrage — 20 token pairs, 0.2% fee to protocol treasury.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", borderRadius: "999px", background: connected ? "rgba(52,211,153,0.08)" : "rgba(100,116,139,0.1)", border: `1px solid ${connected ? "rgba(52,211,153,0.3)" : "rgba(100,116,139,0.2)"}` }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: connected ? "#34d399" : "#64748b", boxShadow: connected ? "0 0 8px #34d399" : "none", animation: connected ? "fadeIn 1.5s infinite alternate" : "none" }} />
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: connected ? "#34d399" : "#64748b" }}>{connected ? "ENGINE LIVE" : "CONNECTING..."}</span>
          </div>
        </div>
      </header>

      {/* Metric Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px" }}>
        <MetricCard label="Total Scans" value={status.scans.toLocaleString()} sub="~12s per scan" color="#60a5fa" icon={<Speed fontSize="small" />} />
        <MetricCard label="Trades Executed" value={String(status.trades)} sub={`${status.profits} profit / ${status.losses} err`} color="#fbbf24" icon={<SwapHoriz fontSize="small" />} />
        <MetricCard label="Net PnL (SOL)" value={(status.netSol >= 0 ? "+" : "") + status.netSol.toFixed(5)} sub={`≈ $${netUsd} USD`} color={netColor} icon={<TrendingUp fontSize="small" />} />
        <MetricCard label="Trade Size" value={`${status.tradeSizeSol.toFixed(3)} SOL`} sub="Auto-compounds with wallet" color="#a78bfa" icon={<FlashOn fontSize="small" />} />
      </div>

      {/* Revenue Narrative */}
      <div style={{ background: "linear-gradient(135deg, rgba(167,139,250,0.06), rgba(52,211,153,0.04))", border: "1px solid rgba(167,139,250,0.2)", borderRadius: "16px", padding: "20px 24px", display: "flex", gap: "16px", alignItems: "flex-start" }}>
        <div style={{ fontSize: "1.4rem" }}>💎</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: "4px" }}>$PCP Fee Revenue</div>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.6 }}>
            Every arbitrage trade executed by this engine earns a <strong style={{ color: "#a78bfa" }}>0.2% platform fee</strong> that accrues to the PocketChange protocol treasury. $PCP holders receive a proportional share of accumulated fees via the governance vault.
          </div>
        </div>
      </div>

      {/* Main content: scan log + trades */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>

        {/* Live Scan Output */}
        <div className="glassmorphism" style={{ borderRadius: "16px", padding: "20px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <h3 style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#60a5fa", fontWeight: 600 }}>Live Scan Output</h3>
            <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>updates every 3s</span>
          </div>
          <div ref={scrollRef} style={{ height: "260px", overflowY: "auto", display: "flex", flexDirection: "column-reverse" }}>
            {status.lastScans.length === 0
              ? <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", marginTop: "auto" }}>Awaiting engine data...</div>
              : [...status.lastScans].reverse().map((l, i) => <ScanLine key={i} line={l} />)}
          </div>
        </div>

        {/* Trade Events */}
        <div className="glassmorphism" style={{ borderRadius: "16px", padding: "20px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <h3 style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#34d399", fontWeight: 600, marginBottom: "12px" }}>Confirmed Trades</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", height: "260px", overflowY: "auto" }}>
            {status.tradeEvents.length === 0 ? (
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginTop: "16px" }}>
                Waiting for first profitable trade...<br />
                <span style={{ fontSize: "0.72rem", color: "#334155" }}>Engine fires when gross &gt; 0 on any pair</span>
              </div>
            ) : [...status.tradeEvents].reverse().map((e, i) => (
              <a key={i} href={`https://solscan.io/tx/${e.tx}`} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>
                <div style={{ background: "rgba(52,211,153,0.04)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: "10px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "border-color 0.2s" }}>
                  <div>
                    <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#34d399" }}>{e.tx.slice(0, 22)}...</div>
                    <div style={{ fontSize: "0.65rem", color: "var(--text-secondary)", marginTop: "2px" }}>{e.ts}</div>
                  </div>
                  <OpenInNew style={{ fontSize: "0.9rem", color: "#64748b" }} />
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Sniper Status */}
      <div className="glassmorphism" style={{ borderRadius: "16px", padding: "16px 20px", border: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: "12px", alignItems: "center" }}>
        <ErrorOutline style={{ color: "#fbbf24", fontSize: "1rem" }} />
        <div>
          <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-secondary)", marginBottom: "2px" }}>Sniper Engine</div>
          <div style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#94a3b8" }}>{status.sniperStatus || "Watching for pump.fun targets..."}</div>
        </div>
      </div>

    </div>
  );
}
