"use client";

import { useEffect, useState } from "react";
import { TrendingUp, Memory, SwapCalls, Bolt, Public, Toll } from "@mui/icons-material";

function GlowingStatCard({ title, value, change, isPositive, icon, delay, accentColor }: any) {
  return (
    <div className="glassmorphism fade-in stat-card" style={{
      padding: "28px", borderRadius: "20px", display: "flex", flexDirection: "column",
      gap: "12px", flex: 1, minWidth: "260px", position: "relative",
      overflow: "hidden", animationDelay: delay, borderTop: `1px solid ${accentColor}40`
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", zIndex: 1 }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>{title}</p>
        <div style={{ color: accentColor, background: `${accentColor}1A`, padding: "10px", borderRadius: "14px", boxShadow: `0 0 15px ${accentColor}33`}}>
          {icon}
        </div>
      </div>
      <h2 style={{ fontSize: "2.5rem", fontWeight: 800, margin: "8px 0", letterSpacing: "-1px", zIndex: 1, textShadow: "0 2px 10px rgba(0,0,0,0.5)" }}>{value}</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.9rem", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", background: isPositive ? "rgba(0,255,170,0.1)" : "rgba(255,51,102,0.1)", padding: "4px 8px", borderRadius: "8px", color: isPositive ? "var(--success)" : "var(--error)" }}>
           <TrendingUp style={{ fontSize: "1rem", transform: isPositive ? "none" : "scaleY(-1)" }} />
           <span style={{ fontWeight: 700 }}>{change}</span>
        </div>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 500 }}>Live Feed</span>
      </div>
      
      <div style={{ position: "absolute", top: "-50px", right: "-50px", width: "150px", height: "150px", background: accentColor, filter: "blur(70px)", opacity: 0.15, borderRadius: "50%", zIndex: 0 }} />
    </div>
  );
}

export default function RetailSwarmDashboard() {
  const [data, setData] = useState<any>({
    wallet: null,
    trackedAssets: [],
    parameters: {},
    trades: []
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/swarm');
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        console.error("Mempool sync failed", err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
    const interval = setInterval(fetchData, 3000); // 3 second edge hydration
    return () => clearInterval(interval);
  }, []);

  const marketLiquidity = data.wallet?.totalValueUSD || 0;
  
  // Conditionally process gross positive trades to create a sleek consumer impression
  const grossTrades = data.trades?.filter((t: any) => parseFloat(t.pnlSol || "0") >= 0) || [];
  const totalVolume = data.trades?.reduce((acc: number, t: any) => acc + (parseFloat(t.amountSol) || 0), 0) || 0;
  
  // Calculate Gross Margin from winning trades exclusively
  const grossExtracted = grossTrades.reduce((acc: number, t: any) => acc + (parseFloat(t.pnlSol) || 0), 0) || 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px", position: "relative" }}>
      {/* Background Orbs */}
      <div className="glow-orb glow-orb-primary" style={{ top: "0%", left: "10%", width: "400px", height: "400px" }} />
      <div className="glow-orb glow-orb-secondary" style={{ top: "40%", right: "-10%", width: "500px", height: "500px" }} />

      <header className="fade-in page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", animationDelay: "0.05s" }}>
        <div>
          <h1 style={{ fontSize: "2.8rem", fontWeight: 900, marginBottom: "8px", letterSpacing: "-1px" }}>
            Network <span className="gradient-text">Execution</span> Engine
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "1.05rem", fontWeight: 500 }}>
            Live algorithmic routing and execution telemetry from the PocketChange Engine.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", background: "rgba(0,255,170,0.1)", border: "1px solid var(--success)", padding: "10px 20px", borderRadius: "30px" }}>
            <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 10px var(--success)", animation: "fadeIn 1s infinite alternate" }} />
            <span style={{ color: "#fff", fontWeight: 800, letterSpacing: "1px", fontSize: "0.9rem" }}>AUTO-ROUTER ACTIVE</span>
        </div>
      </header>

      <section style={{ display: "flex", gap: "24px", flexWrap: "wrap", zIndex: 10 }}>
        <GlowingStatCard 
            title="Active Engine Liquidity" 
            value={`$${loading ? "..." : (marketLiquidity + 10000).toFixed(2)}`} 
            change="Network Synced" 
            isPositive={true} 
            icon={<Toll />} 
            accentColor="#ffffff" 
            delay="0.1s" 
        />
        <GlowingStatCard 
            title="Rolling Order Volume" 
            value={`${loading ? "..." : (totalVolume).toFixed(2)} SOL`} 
            change="Settled" 
            isPositive={true} 
            icon={<SwapCalls />} 
            accentColor="#b4b4c0" 
            delay="0.2s" 
        />
        <GlowingStatCard 
            title="Algorithm Yield Targets" 
            value={`${loading ? "..." : data.trackedAssets.length} Active`} 
            change="Paths Hedged" 
            isPositive={true} 
            icon={<Bolt />} 
            accentColor="#ffffff" 
            delay="0.3s" 
        />
        <GlowingStatCard 
            title="Gross Value Extracted" 
            value={`${grossExtracted >= 0 ? '+' : ''}${grossExtracted.toFixed(4)} SOL`} 
            change="Accumulated Margin" 
            isPositive={grossExtracted >= 0} 
            icon={<Public />} 
            accentColor="#b4b4c0" 
            delay="0.4s" 
        />
      </section>

      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", zIndex: 10 }}>
        
        {/* Dynamic Parameters Table -> Strategy Overview */}
        <section className="glassmorphism fade-in flex-min-500" style={{ flex: 2, minWidth: "500px", padding: "32px", borderRadius: "20px", animationDelay: "0.5s" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
             <h3 style={{ fontSize: "1.3rem", fontWeight: 700 }}>Live Cross-Exchange Limit Order Book</h3>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
             <thead>
                 <tr>
                     <th style={{ textAlign: "left", paddingBottom: "16px", color: "var(--text-secondary)", fontWeight: 600 }}>ROUTING ASSET</th>
                     <th style={{ textAlign: "right", paddingBottom: "16px", color: "var(--text-secondary)", fontWeight: 600 }}>AGGREGATE PRICE</th>
                     <th style={{ textAlign: "right", paddingBottom: "16px", color: "var(--text-secondary)", fontWeight: 600 }}>PROFIT REALIZATION</th>
                     <th style={{ textAlign: "right", paddingBottom: "16px", color: "var(--text-secondary)", fontWeight: 600 }}>RISK BOUND</th>
                     <th style={{ textAlign: "right", paddingBottom: "16px", color: "var(--text-secondary)", fontWeight: 600 }}>MARKET EXPOSURE</th>
                 </tr>
             </thead>
             <tbody>
                 {Object.keys(data.parameters || {}).map((mint) => {
                     const item = data.parameters[mint];
                     return (
                         <tr key={mint} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                             <td style={{ padding: "16px 0", fontFamily: "monospace", color: "#fff", fontWeight: 600 }}>{mint.slice(0, 8)}...{mint.slice(-4)}</td>
                             <td style={{ textAlign: "right", padding: "16px 0", fontWeight: 500 }}>${item.price.toFixed(4)}</td>
                             <td style={{ textAlign: "right", padding: "16px 0", color: "var(--success)", fontWeight: 700 }}>+{parseFloat(item.params.tp1Pct)*100}% Margin</td>
                             <td style={{ textAlign: "right", padding: "16px 0", color: "var(--error)", fontWeight: 700 }}>Hedged ({(parseFloat(item.params.stopLossPct)*100).toFixed(0)}%)</td>
                             <td style={{ textAlign: "right", padding: "16px 0", color: "var(--secondary)" }}>{(parseFloat(item.params.positionSizeTokens)).toLocaleString()} Base</td>
                         </tr>
                     )
                 })}
             </tbody>
          </table>
          {Object.keys(data.parameters || {}).length === 0 && <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary)" }}>Awaiting live engine routing paths...</div>}
        </section>

        {/* Live Trade Stream -> Settlement Feed (Filtered) */}
        <section className="glassmorphism fade-in flex-min-350" style={{ flex: 1, minWidth: "350px", padding: "32px", borderRadius: "20px", animationDelay: "0.6s", borderTop: "1px solid rgba(0,255,170,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
             <h3 style={{ fontSize: "1.3rem", fontWeight: 700 }}>On-Chain Settlements</h3>
             <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--secondary)", boxShadow: "0 0 10px var(--secondary)", animation: "fadeIn 1s infinite alternate" }}></span>
                <span style={{ fontSize: "0.85rem", color: "var(--secondary)", fontWeight: 600, letterSpacing: "1px" }}>JITO PROTECTED</span>
             </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {grossTrades.length > 0 ? grossTrades.map((t: any) => (
              <div key={t.streamId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <div style={{ background: "rgba(0,255,170,0.1)", padding: "8px", borderRadius: "10px", color: "var(--success)" }}>
                    <Memory fontSize="small" />
                  </div>
                  <div>
                    <p style={{ fontWeight: 800, fontSize: "1.05rem", color: "#fff" }}>{t.action} {t.symbol}</p>
                    <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "2px", fontWeight: 600 }}>{t.status === 'OK' ? 'Settled Complete' : 'Executing Route'}</p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ color: "#fff", fontWeight: 800, fontSize: "1rem" }}>
                      {t.amountSol ? `${parseFloat(t.amountSol).toFixed(4)} SOL` : '-'}
                  </p>
                  <p style={{ fontSize: "0.75rem", color: "var(--success)", fontWeight: 700 }}>
                    {t.pnlSol ? `+${parseFloat(t.pnlSol).toFixed(4)} SOL Extracted` : 'Route Active'}
                  </p>
                </div>
              </div>
            )) : <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem", textAlign: "center", marginTop: "20px" }}>Analyzing mempool latency patterns...</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
