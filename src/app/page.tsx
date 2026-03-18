"use client";

import { TrendingUp, AccountBalanceWallet, SwapCalls, Bolt, Public, AccountCircle, Memory } from "@mui/icons-material";
import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Scanner from '../components/Scanner';
import StrategyBuilder from '../components/Strategy';
import Analytics from '../components/Analytics';
import Tokenomics from '../components/Tokenomics';
import Security from '../components/Security';

function GlowingStatCard({ title, value, change, isPositive, icon, delay, accentColor }: any) {
  return (
    <div className="glassmorphism fade-in" style={{
      padding: "28px",
      borderRadius: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      flex: 1,
      minWidth: "260px",
      position: "relative",
      overflow: "hidden",
      animationDelay: delay,
      borderTop: `1px solid ${accentColor}40`
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
        <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 500 }}>24h active</span>
      </div>
      
      {/* Dynamic Glow orb behind the card */}
      <div style={{
        position: "absolute",
        top: "-50px",
        right: "-50px",
        width: "150px",
        height: "150px",
        background: accentColor,
        filter: "blur(70px)",
        opacity: 0.15,
        borderRadius: "50%",
        zIndex: 0
      }} />
    </div>
  );
}

export default function DashboardPage() {
  const { connected, publicKey } = useWallet();
  const [data, setData] = useState<any>({
      tvl: "$...", apy: "...", emitted: "...", totalUsers: "...", mode: "..."
  });
  const [tradesStream, setTradesStream] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<string>('Dashboard');

  // Fetch Protocol Stats & Trades
  useEffect(() => {
    const fetchData = async () => {
      try {
        const statsRes = await fetch('/api/stats');
        const tradesRes = await fetch('/api/trades');
        const statsData = await statsRes.json();
        const tradesData = await tradesRes.json();
        setData(statsData);
        setTradesStream(tradesData);
      } catch (err) {
        console.error("Failed to load metrics", err);
      }
    };
    
    fetchData();
    const interval = setInterval(fetchData, 5000); // Polling every 5s
    return () => clearInterval(interval);
  }, []);

  // --- STAKING STATE ---
  const [stakedBalance, setStakedBalance] = useState<number>(0);
  const [stakeInput, setStakeInput] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [yieldEarned, setYieldEarned] = useState<number>(0);

  // Simulate Yield generation
  useEffect(() => {
    if (stakedBalance > 0) {
      const interval = setInterval(() => {
        setYieldEarned(prev => prev + (stakedBalance * 0.00001)); // Mock yield
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [stakedBalance]);

  const handleStake = async () => {
    if (!stakeInput || isNaN(Number(stakeInput))) return;
    setIsProcessing(true);
    // Simulate transaction delay
    await new Promise(r => setTimeout(r, 1500));
    setStakedBalance(prev => prev + Number(stakeInput));
    setStakeInput("");
    setIsProcessing(false);
  };

  const handleUnstake = async () => {
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 1500));
    setStakedBalance(0);
    setYieldEarned(0);
    setIsProcessing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px", position: "relative" }}>
      {/* Background Orbs */}
      <div className="glow-orb glow-orb-primary" style={{ top: "0%", left: "10%", width: "400px", height: "400px" }} />
      <div className="glow-orb glow-orb-secondary" style={{ top: "40%", right: "-10%", width: "500px", height: "500px" }} />

      <header className="fade-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", animationDelay: "0.05s" }}>
        <div>
          <h1 style={{ fontSize: "2.8rem", fontWeight: 900, marginBottom: "8px", letterSpacing: "-1px" }}>
            PocketChange <span className="gradient-text">Vault</span>
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "1.05rem", fontWeight: 500 }}>
            Deposit crypto. Earn institutional-grade DeFi Arbitrage Yields natively.
          </p>
        </div>
        <div style={{ zIndex: 10 }}>
          <WalletMultiButton className="neon-btn" style={{ 
            background: connected ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 255, 255, 0.05)",
            border: connected ? "1px solid rgba(255, 255, 255, 0.3)" : "1px solid rgba(255, 255, 255, 0.15)",
            color: "#fff",
            borderRadius: "12px",
            fontFamily: "Inter",
            fontWeight: 700,
            boxShadow: connected ? "0 0 20px rgba(255, 255, 255, 0.15)" : "0 0 15px rgba(255, 255, 255, 0.05)"
          }} />
        </div>
      </header>

      {/* --- TAB NAVIGATION --- */}
      <nav className="fade-in" style={{ display: "flex", gap: "12px", background: "rgba(255,255,255,0.02)", padding: "12px", borderRadius: "20px", border: "1px solid rgba(255,255,255,0.05)", overflowX: "auto", animationDelay: "0.08s", zIndex: 10 }}>
        {['Dashboard', 'Scanner', 'Strategy', 'Analytics', 'Tokenomics', 'Security'].map(tab => (
          <button 
            key={tab}
            onClick={() => setActiveTab(tab)} 
            style={{
              padding: "10px 24px", 
              background: activeTab === tab ? "rgba(255,255,255,0.1)" : "transparent",
              color: activeTab === tab ? "#fff" : "var(--text-secondary)",
              borderRadius: "12px",
              fontWeight: 700,
              border: activeTab === tab ? "1px solid rgba(255,255,255,0.2)" : "1px solid transparent",
              transition: "all 0.2s"
            }}
          >
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === 'Scanner' && <Scanner />}
      {activeTab === 'Strategy' && <StrategyBuilder />}
      {activeTab === 'Analytics' && <Analytics />}
      {activeTab === 'Tokenomics' && <Tokenomics />}
      {activeTab === 'Security' && <Security />}

      {activeTab === 'Dashboard' && (
        <>
          {/* --- PERSONAL STAKING DASHBOARD (VISIBLE WHEN CONNECTED) --- */}
          {connected && (
            <section className="glassmorphism fade-in hover-glow" style={{ padding: "32px", borderRadius: "20px", display: "flex", flexDirection: "column", gap: "24px", zIndex: 10, animationDelay: "0.1s", border: "1px solid rgba(0, 255, 170, 0.2)", background: "rgba(15, 23, 42, 0.6)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: "1.4rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" }}>
              <AccountCircle style={{ color: "var(--success)" }} /> Your Staking Vault
            </h3>
            <div style={{ background: "rgba(0, 255, 170, 0.1)", padding: "6px 12px", borderRadius: "8px", color: "var(--success)", fontSize: "0.85rem", fontWeight: 700 }}>
              Connected: {publicKey?.toBase58().substring(0, 4)}...{publicKey?.toBase58().substring(40)}
            </div>
          </div>
          
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "20px" }}>
             <div style={{ background: "rgba(255,255,255,0.03)", padding: "20px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.05)" }}>
               <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>Staked Balance</p>
               <h4 style={{ fontSize: "2rem", fontWeight: 800 }}>{stakedBalance.toLocaleString()} <span style={{ fontSize: "1rem", color: "var(--text-secondary)" }}>USDC</span></h4>
             </div>
             <div style={{ background: "rgba(255,255,255,0.03)", padding: "20px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.05)" }}>
               <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>Yield Earned</p>
               <h4 style={{ fontSize: "2rem", fontWeight: 800, color: "var(--success)" }}>+${yieldEarned.toFixed(6)}</h4>
             </div>
             <div style={{ background: "rgba(255,255,255,0.03)", padding: "20px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.05)" }}>
               <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>Size Multiplier</p>
               <h4 style={{ fontSize: "2rem", fontWeight: 800, color: "var(--primary)" }}>{stakedBalance > 1000 ? "1.25x" : "1.00x"} <span style={{ fontSize: "0.9rem", color: "var(--text-secondary)", fontWeight: 500 }}>(Dynamic)</span></h4>
             </div>
          </div>

          <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
            <input 
              type="number" 
              placeholder="Amount to Stake (USDC)" 
              value={stakeInput}
              onChange={(e) => setStakeInput(e.target.value)}
              style={{ flex: 1, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px", padding: "12px 16px", color: "#fff", outline: "none", fontSize: "1rem" }}
            />
            <button 
              onClick={handleStake}
              disabled={isProcessing || !stakeInput}
              style={{ background: isProcessing ? "#555" : "linear-gradient(90deg, #00FFaa, #00ccff)", padding: "0 32px", borderRadius: "12px", color: "#000", fontWeight: 800, fontSize: "1rem", border: "none", cursor: isProcessing ? "not-allowed" : "pointer" }}
            >
              {isProcessing ? "Processing..." : "Stake Funds"}
            </button>
            {stakedBalance > 0 && (
              <button 
                 onClick={handleUnstake}
                 disabled={isProcessing}
                 style={{ background: "rgba(255,51,102,0.1)", border: "1px solid rgba(255,51,102,0.3)", padding: "0 24px", borderRadius: "12px", color: "var(--error)", fontWeight: 700, fontSize: "1rem", cursor: isProcessing ? "not-allowed" : "pointer" }}
              >
                Unstake
              </button>
            )}
          </div>
        </section>
      )}

      {/* --- PUBLIC SECTIONS (Always Visible) --- */}
      <section style={{ display: "flex", gap: "24px", flexWrap: "wrap", zIndex: 10 }}>
        <GlowingStatCard title="Current Vault APY" value={data.apy} change="Variable" isPositive={true} icon={<TrendingUp />} accentColor="#ffffff" delay="0.1s" />
        <GlowingStatCard title="Total Value Locked" value={data.tvl} change="+12.4% vs 30d" isPositive={true} icon={<AccountBalanceWallet />} accentColor="#b4b4c0" delay="0.2s" />
        <GlowingStatCard title="xPKC Yield Emitted" value={data.emitted} change="Staking Rewards" isPositive={true} icon={<SwapCalls />} accentColor="#ffffff" delay="0.3s" />
        <GlowingStatCard title="Active Depositors" value={data.totalUsers} change="+412 Today" isPositive={true} icon={<Public />} accentColor="#b4b4c0" delay="0.4s" />
      </section>

      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", zIndex: 10 }}>
        {/* Main Chart Section */}
        <section className="glassmorphism fade-in" style={{ flex: 2, minWidth: "500px", borderRadius: "20px", display: "flex", flexDirection: "column", animationDelay: "0.5s", overflow: "hidden" }}>
          <div style={{ padding: "32px 32px 0 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
               <h3 style={{ fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.5px" }}>Cumulative Yield Trajectory</h3>
               <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginTop: "4px" }}>Auto-compounding performance over the last 30 days.</p>
            </div>
            <select style={{ background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "#fff", padding: "10px 16px", borderRadius: "10px", outline: "none", fontWeight: 600, cursor: "pointer", backdropFilter: "blur(10px)" }}>
              <option>Last 7 Days</option>
              <option>Last 30 Days</option>
              <option>Year to Date</option>
            </select>
          </div>
          
          <div style={{ width: "100%", height: "220px", marginTop: "auto", position: "relative" }}>
             <div className="wave-graph" style={{ position: "absolute", bottom: 0, width: "100%" }}></div>
             {/* Secondary subtle wave */}
             <div className="wave-graph" style={{ position: "absolute", bottom: "-10px", width: "100%", opacity: 0.5, animationDuration: "15s", filter: "hue-rotate(60deg)" }}></div>
          </div>
        </section>

        {/* Live Execution Stream */}
        <section className="glassmorphism fade-in" style={{ flex: 1, minWidth: "350px", padding: "32px", borderRadius: "20px", animationDelay: "0.6s", position: "relative", borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
             <h3 style={{ fontSize: "1.3rem", fontWeight: 700 }}>Live Mempool Stream</h3>
             <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--secondary)", boxShadow: "0 0 10px var(--secondary)", animation: "fadeIn 1s infinite alternate" }}></span>
                <span style={{ fontSize: "0.85rem", color: "var(--secondary)", fontWeight: 600, letterSpacing: "1px" }}>SYNCED</span>
             </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {tradesStream.map((log) => (
              <div key={log.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <div style={{ background: log.ok ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.02)", padding: "8px", borderRadius: "10px", color: log.ok ? "var(--success)" : "var(--text-secondary)" }}>
                    <Memory fontSize="small" />
                  </div>
                  <div>
                    <p style={{ fontWeight: 700, fontSize: "0.95rem", color: log.ok ? "#fff" : "var(--text-secondary)" }}>{log.route}</p>
                    <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontFamily: "monospace", marginTop: "2px" }}>{log.hash}</p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ color: log.ok ? "var(--success)" : "var(--text-secondary)", fontWeight: 800, fontSize: "1rem" }}>
                      {log.profit}
                  </p>
                  <p style={{ fontSize: "0.7rem", color: log.ok ? "var(--secondary)" : "var(--error)", letterSpacing: "0.5px", fontWeight: 700 }}>
                    {log.status}
                  </p>
                </div>
              </div>
            ))}
            {tradesStream.length === 0 && (
              <p style={{ color: "var(--text-secondary)", textAlign: "center", fontSize: "0.9rem" }}>Awaiting execution logs...</p>
            )}
          </div>
        </section>
      </div>

        </>
      )}
    </div>
  );
}
