"use client";

import { ShowChart, TrendingUp, TrendingDown, ErrorOutline, DataUsage, Assessment, AutoGraph } from "@mui/icons-material";
import { useState, useEffect } from "react";

export default function AnalyticsPage() {
  const [data, setData] = useState<any>({
      totalTrades: 0, winRate: "0.0%", totalPnL: "0.00 SOL", volume: "0.00 SOL"
  });
  const [engineData, setEngineData] = useState<any>(null);

  useEffect(() => {
      fetch('/api/analytics').then(r => r.json()).then(res => {
          if (!res.error) setData(res);
      }).catch(() => {});

      fetch('/api/engine?path=status').then(r => r.json()).then(status => {
          if (!status.error) setEngineData(status);
      }).catch(() => {});
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.5s ease" }}>
      <header>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px" }}>Analytics Engine</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>Deep dive into your arbitrage strategy performance and latency metrics.</p>
      </header>

      {/* Top row cards */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "24px" }}>
        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px", border: "1px solid rgba(138,43,226,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
             <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Total Routing PnL</p>
             <Assessment style={{ color: "var(--primary)" }} />
          </div>
          <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff" }}>{data.totalPnL}</h2>
          <p style={{ color: "var(--success)", fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "4px", marginTop: "8px" }}>
              <TrendingUp fontSize="small" /> +Live Data
          </p>
        </div>

        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
             <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Win Rate</p>
             <AutoGraph style={{ color: "var(--secondary)" }} />
          </div>
          <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff" }}>{data.winRate}</h2>
          <p style={{ color: "var(--success)", fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "4px", marginTop: "8px" }}>
              <TrendingUp fontSize="small" /> +Jito Protected
          </p>
        </div>

        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
             <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Total Volume</p>
             <DataUsage style={{ color: "#ffd600" }} />
          </div>
          <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff" }}>{data.volume}</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginTop: "8px" }}>
              Across {data.totalTrades} Live Operations
          </p>
        </div>

        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
             <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Avg Slippage</p>
             <ErrorOutline style={{ color: "var(--error)" }} />
          </div>
          <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff" }}>0.012%</h2>
          <p style={{ color: "var(--success)", fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "4px", marginTop: "8px" }}>
              <TrendingDown fontSize="small" /> Optimally tight routing
          </p>
        </div>
      </section>

      {/* Engine Live Metrics */}
      {engineData && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "24px" }}>
          <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px", border: "1px solid rgba(0,255,170,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
              <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Engine Mode</p>
              <ShowChart style={{ color: "var(--success)" }} />
            </div>
            <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff", textTransform: "uppercase" as const }}>{engineData.mode || "offline"}</h2>
            <p style={{ color: engineData.circuit_breaker?.active ? "var(--error)" : "var(--success)", fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "4px", marginTop: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", display: "inline-block", background: engineData.circuit_breaker?.active ? "var(--error)" : "var(--success)" }} />
              {engineData.circuit_breaker?.active ? `Breaker: ${engineData.circuit_breaker.reason || "TRIPPED"}` : "Circuit Breaker OK"}
            </p>
          </div>

          <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
              <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Engine Uptime</p>
              <TrendingUp style={{ color: "var(--primary)" }} />
            </div>
            <h2 style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff" }}>
              {engineData.uptime_secs ? `${Math.floor(engineData.uptime_secs / 3600)}h ${Math.floor((engineData.uptime_secs % 3600) / 60)}m` : "--"}
            </h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginTop: "8px" }}>
              {engineData.uptime_secs ? `${engineData.uptime_secs.toLocaleString()}s total` : "Engine not connected"}
            </p>
          </div>
        </section>
      )}

      {/* Main Charts area */}
      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
        {/* PnL Growth Chart */}
        <section className="glassmorphism fade-in flex-min-500" style={{ flex: 2, minWidth: "500px", padding: "32px", borderRadius: "16px" }}>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 600, marginBottom: "24px" }}>Cummulative PnL (Rolling 30 Days)</h3>
            
            {/* Mock Chart Area */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: "12px", height: "250px", borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: "16px" }}>
                {[12, 18, 14, 25, 32, 28, 45, 52, 48, 60, 68, 72, 85, 90, 88].map((val, i) => (
                    <div key={i} style={{
                        flex: 1, 
                        background: val > 50 ? "linear-gradient(to top, var(--primary), var(--secondary))" : "rgba(138,43,226, 0.4)",
                        height: `${val}%`,
                        borderRadius: "4px 4px 0 0",
                        position: "relative",
                        transition: "height 0.5s ease"
                    }}></div>
                ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "16px", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                <span>Mar 01</span>
                <span>Mar 15</span>
                <span>Mar 30</span>
            </div>
        </section>

        {/* Top 5 Wallets Ranked */}
        <section className="glassmorphism fade-in flex-min-350" style={{ flex: 1, minWidth: "350px", padding: "32px", borderRadius: "16px" }}>
             <h3 style={{ fontSize: "1.2rem", fontWeight: 600, marginBottom: "24px" }}>Top Performing Fleet Wallets</h3>
             <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                 {[
                     { key: "E883...nqJxP", pnl: "+145.2 SOL", color: "var(--success)", rank: 1 },
                     { key: "F7J8...vu36D", pnl: "+82.4 SOL", color: "var(--success)", rank: 2 },
                     { key: "5vew...KjMH", pnl: "+45.1 SOL", color: "var(--success)", rank: 3 },
                     { key: "EoMr...3nzW", pnl: "+32.8 SOL", color: "var(--success)", rank: 4 },
                     { key: "6bzZ...vhNm", pnl: "+12.0 SOL", color: "var(--success)", rank: 5 },
                 ].map((w) => (
                     <div key={w.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "rgba(0,0,0,0.2)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)" }}>
                         <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                             <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: w.rank === 1 ? "linear-gradient(135deg, #ffd600, #ff8f00)" : "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8rem", fontWeight: 700, color: w.rank === 1 ? "#000" : "#fff" }}>
                                 {w.rank}
                             </div>
                             <span style={{ fontWeight: 600, fontFamily: "monospace", letterSpacing: "1px", color: "var(--secondary)" }}>{w.key}</span>
                         </div>
                         <strong style={{ color: w.color }}>{w.pnl}</strong>
                     </div>
                 ))}
             </div>
        </section>
      </div>

    </div>
  );
}
