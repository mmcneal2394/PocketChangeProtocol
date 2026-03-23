"use client";

import { PlayArrow, Stop, Speed, NetworkCheck, Router, NetworkPing, SwapHoriz, CheckCircle, Cancel, HourglassEmpty } from "@mui/icons-material";
import { useState, useRef, useEffect, useCallback } from "react";

interface EngineStatusData {
  mode?: string;
  uptime_secs?: number;
  circuit_breaker?: { active: boolean; reason?: string };
  error?: string;
}

interface OpportunityData {
  id: string;
  strategy: string;
  route: string;
  expected_profit_pct: number | string;
  trade_size_usdc: number | string;
}

export default function YieldStrategies() {
  const [isRunning, setIsRunning] = useState(false);
  const [capitalAllocation, setCapitalAllocation] = useState(500000); // 500k TVL allocation
  const [strategyMix, setStrategyMix] = useState(5); // 5 Core Strategies

  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    "[PCP] Arbitrage execution layer offline. Awaiting activation..."
  ]);

  const [metrics, setMetrics] = useState({
    avgYield: 0,
    ptbSuccessRate: 0,
    activeStrategies: 0,
    flashLoansExecuted: 0,
  });

  const [engineStatus, setEngineStatus] = useState<EngineStatusData | null>(null);
  const [opportunities, setOpportunities] = useState<OpportunityData[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchEngineData = useCallback(() => {
    fetch('/api/engine?path=status')
      .then(r => r.json())
      .then(status => { if (!status.error) setEngineStatus(status); })
      .catch(() => {});

    fetch('/api/engine?path=opportunities')
      .then(r => r.json())
      .then(opps => { if (Array.isArray(opps)) setOpportunities(opps); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchEngineData();
    const interval = setInterval(fetchEngineData, 4000);
    return () => clearInterval(interval);
  }, [fetchEngineData]);

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    setActionLoading(id);
    try {
      await fetch('/api/engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      // Refresh opportunities list
      fetchEngineData();
    } catch {
      // ignore
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [consoleLogs]);

  const addLog = (msg: string) => {
    setConsoleLogs(prev => [...prev, `[${new Date().toISOString().split('T')[1].slice(0, 11)}] ${msg}`]);
  };

  const startLoadTest = () => {
    setIsRunning(true);
    setConsoleLogs([]);
    addLog(`INITIALIZING MEV PROTECTED BUNDLER...`);
    addLog(`Deploying ${strategyMix} strategies across Jito private mempool...`);
    addLog(`Allocating $${capitalAllocation.toLocaleString()} USDC from Vault...`);
    
    setMetrics({ avgYield: 0, ptbSuccessRate: 100, activeStrategies: strategyMix, flashLoansExecuted: 0 });

    let currentEvent = 0;
    let localLoans = 0;
    
    const strategies = [
        "Triangular Arbitrage (SOL-USDC-USDT)",
        "CEX-DEX Arbitrage (Bitget-Raydium)",
        "Flash Loan Jup-Routing",
        "Negative Rate Lending Loop",
        "Prediction Market Arb (Polymarket)"
    ];
    
    const interval = setInterval(() => {
        currentEvent++;
        
        const executedStrats = Math.floor(Math.random() * strategyMix) + 1;
        localLoans += Math.floor(Math.random() * 3);
        
        const currentYield = 0.5 + (Math.random() * 2.5); // % yield representation
        const currentSuccessRate = 95 + (Math.random() * 4.9);
        
        setMetrics({
           activeStrategies: strategyMix,
           flashLoansExecuted: localLoans,
           avgYield: currentYield,
           ptbSuccessRate: currentSuccessRate
        });
        
        if (currentEvent % 4 === 0) {
           const strat = strategies[Math.floor(Math.random() * strategies.length)];
           addLog(`[Block ${currentEvent}] Executed PTB for ${strat}. Extracted +${currentYield.toFixed(2)}% net.`);
        }
        
        if (currentEvent >= 50) { // Limit sim
            clearInterval(interval);
            setIsRunning(false);
            addLog(`✅ EXECUTION CYCLE COMPLETE. Yield locked to Vault.`);
            addLog(`Results: Secured protocol profit across ${localLoans} flash loans.`);
            setMetrics(m => ({ ...m, activeStrategies: 0 }));
        }
    }, 300);
  };

  const stopLoadTest = () => {
    setIsRunning(false);
    addLog("⚠️ MANUAL HALT. Sent SIGKILL to execution engines.");
    setMetrics(m => ({ ...m, activeStrategies: 0 }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.5s ease" }}>
       
      <header>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px", display: "flex", alignItems: "center", gap: "12px" }}>
            <SwapHoriz style={{ fontSize: "2.5rem", color: "var(--primary)" }} /> Core Arbitrage Strategies
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>
          Monitor the PocketChange atomic PTB execution engines across MEV-protected bundles.
        </p>
      </header>

      <section className="grid-1fr-2fr" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "32px" }}>
        {/* Controls */}
        <div className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.15)" }}>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 600, marginBottom: "24px", color: "white" }}>Strategy Deployment</h3>
            
            <div style={{ marginBottom: "24px" }}>
                <label style={{ color: "var(--text-secondary)", display: "block", marginBottom: "8px", fontSize: "0.9rem" }}>
                    Capital Allocation Constraint (USDC)
                </label>
                <input 
                  type="range" min="10000" max="5000000" step="10000"
                  value={capitalAllocation} onChange={(e) => setCapitalAllocation(Number(e.target.value))}
                  disabled={isRunning}
                  style={{ width: "100%", accentColor: "var(--primary)" }}
                />
                <div style={{ textAlign: "right", marginTop: "4px", fontSize: "1.1rem", fontWeight: 700, color: "white" }}>
                    ${capitalAllocation.toLocaleString()}
                </div>
            </div>

            <div style={{ marginBottom: "32px" }}>
                <label style={{ color: "var(--text-secondary)", display: "block", marginBottom: "8px", fontSize: "0.9rem" }}>
                    Active PTB Sequences
                </label>
                <input 
                  type="range" min="1" max="5" step="1"
                  value={strategyMix} onChange={(e) => setStrategyMix(Number(e.target.value))}
                  disabled={isRunning}
                  style={{ width: "100%", accentColor: "var(--secondary)" }}
                />
                <div style={{ textAlign: "right", marginTop: "4px", fontSize: "1.1rem", fontWeight: 700, color: "white" }}>
                    {strategyMix} Core Strategies Active
                </div>
            </div>

            <div style={{ display: "flex", gap: "16px" }}>
                {isRunning ? (
                    <button onClick={stopLoadTest} style={{
                        flex: 1, padding: "14px", background: "rgba(255, 255, 255, 0.15)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.4)", borderRadius: "8px", fontWeight: 600, cursor: "pointer", display: "flex", justifyContent: "center", gap: "8px"
                    }}>
                        <Stop /> DEACTIVATE ENGINE
                    </button>
                ) : (
                    <button onClick={startLoadTest} style={{
                        flex: 1, padding: "14px", background: "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", fontWeight: 600, cursor: "pointer", display: "flex", justifyContent: "center", gap: "8px", boxShadow: "0 4px 14px rgba(255,255,255,0.1)"
                    }}>
                        <PlayArrow /> RUN PTB ARBITRAGE
                    </button>
                )}
            </div>
        </div>

        {/* Live Metrics */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
                <div className="glassmorphism" style={{ padding: "24px", borderRadius: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <div style={{ color: "var(--primary)", display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}><Speed /> Average Block Yield</div>
                    <div style={{ fontSize: "2.5rem", fontWeight: 800 }}>{metrics.avgYield.toFixed(2)} <span style={{ fontSize: "1.2rem", color: "var(--text-secondary)" }}>%</span></div>
                    <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "4px" }}>Auto-compounded return spread across CEX and DEX protocols.</p>
                </div>
                
                <div className="glassmorphism" style={{ padding: "24px", borderRadius: "16px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.2)" }}>
                    <div style={{ color: "var(--primary)", display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}><NetworkCheck /> PTB Jito Success Rate</div>
                    <div style={{ fontSize: "2.5rem", fontWeight: 800 }}>{metrics.ptbSuccessRate.toFixed(1)} <span style={{ fontSize: "1.2rem", color: "var(--text-secondary)" }}>%</span></div>
                    <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "4px" }}>Jito bundle acceptance rate securing atomic MEV protection.</p>
                </div>
            </div>

            <div className="glassmorphism" style={{ flex: 1, borderRadius: "16px", padding: "24px", position: "relative" }}>
                 <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
                     <h3 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Active Test Output</h3>
                     <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                         {metrics.flashLoansExecuted.toLocaleString()} Flash Loans Resolved
                     </div>
                 </div>
                 <div ref={scrollRef} style={{ background: "rgba(0,0,0,0.4)", borderRadius: "8px", padding: "16px", height: "200px", overflowY: "auto", fontFamily: "monospace", fontSize: "0.9rem", color: "var(--secondary)" }}>
                     {consoleLogs.map((log, i) => (
                         <div key={i} style={{ marginBottom: "6px" }}>{log}</div>
                     ))}
                 </div>
            </div>
        </div>
      </section>

      {/* Live Engine Status */}
      {engineStatus && (
        <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.1)" }}>
          <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "20px" }}>Live Engine Status</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
            <div style={{ padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: "12px" }}>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 600, marginBottom: "6px" }}>MODE</div>
              <div style={{ fontSize: "1.4rem", fontWeight: 800, textTransform: "uppercase" as const }}>{engineStatus.mode || "offline"}</div>
            </div>
            <div style={{ padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: "12px" }}>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 600, marginBottom: "6px" }}>UPTIME</div>
              <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>
                {engineStatus.uptime_secs ? `${Math.floor(engineStatus.uptime_secs / 3600)}h ${Math.floor((engineStatus.uptime_secs % 3600) / 60)}m` : "--"}
              </div>
            </div>
            <div style={{ padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: "12px" }}>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 600, marginBottom: "6px" }}>CIRCUIT BREAKER</div>
              <div style={{ fontSize: "1.4rem", fontWeight: 800, color: engineStatus.circuit_breaker?.active ? "var(--error)" : "var(--success)" }}>
                {engineStatus.circuit_breaker?.active ? "TRIPPED" : "OK"}
              </div>
              {engineStatus.circuit_breaker?.active && engineStatus.circuit_breaker.reason && (
                <div style={{ fontSize: "0.8rem", color: "var(--error)", marginTop: "4px" }}>{engineStatus.circuit_breaker.reason}</div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Pending Opportunities */}
      <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <h3 style={{ fontSize: "1.2rem", fontWeight: 700 }}>Pending Opportunities</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <HourglassEmpty style={{ fontSize: "1rem", color: "var(--text-secondary)" }} />
            <span style={{ fontSize: "0.9rem", color: "var(--text-secondary)", fontWeight: 600 }}>{opportunities.length} awaiting review</span>
          </div>
        </div>

        {opportunities.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary)", fontSize: "0.95rem" }}>
            No pending opportunities. Opportunities below auto-execute threshold will appear here for manual approval.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {opportunities.map((opp) => (
              <div key={opp.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: "12px",
                border: "1px solid rgba(255,255,255,0.08)"
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{opp.route}</span>
                    <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.08)", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase" as const }}>
                      {opp.strategy}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "16px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    <span>Profit: <strong style={{ color: "var(--success)" }}>+{Number(opp.expected_profit_pct).toFixed(3)}%</strong></span>
                    <span>Size: <strong style={{ color: "#fff" }}>${Number(opp.trade_size_usdc).toLocaleString()}</strong></span>
                    <span style={{ fontFamily: "monospace", fontSize: "0.7rem" }}>ID: {opp.id.slice(0, 12)}...</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", marginLeft: "16px" }}>
                  <button
                    onClick={() => handleAction(opp.id, 'approve')}
                    disabled={actionLoading === opp.id}
                    style={{
                      padding: "8px 16px", borderRadius: "8px", border: "none", cursor: "pointer",
                      background: "rgba(0,255,170,0.2)", color: "var(--success)", fontWeight: 700, fontSize: "0.85rem",
                      display: "flex", alignItems: "center", gap: "4px",
                      opacity: actionLoading === opp.id ? 0.5 : 1,
                    }}
                  >
                    <CheckCircle style={{ fontSize: "1rem" }} /> Approve
                  </button>
                  <button
                    onClick={() => handleAction(opp.id, 'reject')}
                    disabled={actionLoading === opp.id}
                    style={{
                      padding: "8px 16px", borderRadius: "8px", border: "none", cursor: "pointer",
                      background: "rgba(255,51,102,0.2)", color: "var(--error)", fontWeight: 700, fontSize: "0.85rem",
                      display: "flex", alignItems: "center", gap: "4px",
                      opacity: actionLoading === opp.id ? 0.5 : 1,
                    }}
                  >
                    <Cancel style={{ fontSize: "1rem" }} /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
