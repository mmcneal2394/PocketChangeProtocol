"use client";

import { PlayArrow, Stop, Speed, NetworkCheck, Router, NetworkPing, SwapHoriz } from "@mui/icons-material";
import { useState, useRef, useEffect } from "react";

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

  const scrollRef = useRef<HTMLDivElement>(null);

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

      <section style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "32px" }}>
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
    </div>
  );
}
