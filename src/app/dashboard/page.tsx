"use client";

import { TrendingUp, AccountBalanceWallet, SwapCalls, Bolt, Public, AccountCircle, Memory } from "@mui/icons-material";
import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

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

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export default function DashboardPage() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const [data, setData] = useState<any>({
      tvl: "$1.42M", apy: "142.4%", emitted: "84,000 xPKC", totalUsers: "8,941", recentLogs: []
  });
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [txStatus, setTxStatus] = useState("");

  const NETWORK = process.env.NEXT_PUBLIC_NETWORK || "localnet"; 
  const RPC_URL = NETWORK === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";

  const PROGRAM_ID = new PublicKey("GKUwMKjS4UU5zFQXV83oNjm8DZmVpYzyiTGAhHEiCnLR"); // Same ID persists between deployments
  
  // Dynamic Mints based on active network
  const USDC_MINT = NETWORK === "devnet" 
      ? new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") // Common Devnet USDC
      : new PublicKey("J86cnryv65eNYsgXx3KssYcEh34gkDwqwpVR4SYEEoAd"); 

  const PCP_MINT = NETWORK === "devnet"
      ? new PublicKey("PCPxZ3m2v...mockdev") // Placeholder for deployed Devnet PCP
      : new PublicKey("HnroupxERUkWZGzqcqWyXHbGF326rV2MkcT4RNcKY3Aw");

  const handleDeposit = async () => {
      if (!connected || !publicKey) return setTxStatus("Connect wallet first!");
      try {
          setTxStatus(`Constructing Deposit PTB (${NETWORK})...`);
          const connection = new Connection(RPC_URL, "confirmed");

          const [vaultState] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
          const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
          const vaultUsdc = getAssociatedTokenAddressSync(USDC_MINT, vaultState, true);
          const userPcp = getAssociatedTokenAddressSync(PCP_MINT, publicKey);

          const depositData = Buffer.alloc(8 + 8);
          depositData.set(new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]), 0);
          depositData.writeBigInt64LE(BigInt(parseFloat(depositAmount) * 1e6), 8); // u64 amount

          const depositIx = new TransactionInstruction({
              programId: PROGRAM_ID,
              data: depositData,
              keys: [
                  { pubkey: publicKey, isSigner: true, isWritable: true },
                  { pubkey: vaultState, isSigner: false, isWritable: true },
                  { pubkey: PCP_MINT, isSigner: false, isWritable: true },
                  { pubkey: userUsdc, isSigner: false, isWritable: true },
                  { pubkey: vaultUsdc, isSigner: false, isWritable: true },
                  { pubkey: userPcp, isSigner: false, isWritable: true },
                  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              ]
          });

          const tx = new Transaction().add(depositIx);
          const sig = await sendTransaction(tx, connection);
          setTxStatus(`Success! TX: ${sig.slice(0, 10)}...`);
          setDepositAmount("");
      } catch (err: any) {
          console.error(err);
          setTxStatus("Error: " + (err.message || "Simulation Failed"));
      }
  };

  const handleWithdraw = async () => {
      if (!connected || !publicKey) return setTxStatus("Connect wallet first!");
      try {
          setTxStatus(`Constructing Withdraw PTB (${NETWORK})...`);
          const connection = new Connection(RPC_URL, "confirmed");

          const [vaultState] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
          const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
          const vaultUsdc = getAssociatedTokenAddressSync(USDC_MINT, vaultState, true);
          const userPcp = getAssociatedTokenAddressSync(PCP_MINT, publicKey);

          const withdrawData = Buffer.alloc(8 + 8);
          withdrawData.set(new Uint8Array([183, 18, 70, 156, 148, 109, 161, 34]), 0);
          withdrawData.writeBigInt64LE(BigInt(parseFloat(withdrawAmount) * 1e9), 8); // u64 shares

          const withdrawIx = new TransactionInstruction({
              programId: PROGRAM_ID,
              data: withdrawData,
              keys: [
                  { pubkey: publicKey, isSigner: true, isWritable: true },
                  { pubkey: vaultState, isSigner: false, isWritable: true },
                  { pubkey: PCP_MINT, isSigner: false, isWritable: true },
                  { pubkey: userUsdc, isSigner: false, isWritable: true },
                  { pubkey: vaultUsdc, isSigner: false, isWritable: true },
                  { pubkey: userPcp, isSigner: false, isWritable: true },
                  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              ]
          });

          const tx = new Transaction().add(withdrawIx);
          const sig = await sendTransaction(tx, connection);
          setTxStatus(`Withdrawn! TX: ${sig.slice(0, 10)}...`);
          setWithdrawAmount("");
      } catch (err: any) {
          console.error(err);
          setTxStatus("Error: " + (err.message || "Simulation Failed"));
      }
  };

  useEffect(() => {
    // Poll live logs from the backend API route realistically as they hit the JSONL pipeline
    const fetchLogs = async () => {
      try {
        const [logsRes, analyticsRes] = await Promise.all([
          fetch("/api/logs"),
          fetch("/api/analytics")
        ]);
        const logs = await logsRes.json();
        const analytics = await analyticsRes.json();
        
        setData((prev: any) => ({
          ...prev, 
          recentLogs: logs,
          tvl: analytics.volume || "$1.42M", // Dynamically map volume to TVL for MVP
          apy: analytics.winRate || "0.0%",  // WinRate to APY surrogate
          emitted: analytics.totalPnL || "+0.00 USDC", // PnL mapping
          totalUsers: analytics.totalTrades ? analytics.totalTrades.toString() : "0",
        }));
      } catch (err) {
        console.error(err);
      }
    };

    fetchLogs(); // Initial load
    const intervalId = setInterval(fetchLogs, 2500);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px", position: "relative" }}>
      {/* Background Orbs */}
      <div className="glow-orb glow-orb-primary" style={{ top: "0%", left: "10%", width: "400px", height: "400px" }} />
      <div className="glow-orb glow-orb-secondary" style={{ top: "40%", right: "-10%", width: "500px", height: "500px" }} />

      {txStatus && (
          <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "rgba(0,255,170,0.1)", border: "1px solid var(--success)", color: "#fff", padding: "16px", borderRadius: "12px", boxShadow: "0 0 15px rgba(0, 255, 170, 0.2)", backdropFilter: "blur(10px)" }}>
              {txStatus}
              <button onClick={() => setTxStatus("")} style={{ marginLeft: "12px", background: "none", border: "none", color: "#fff", cursor: "pointer", fontWeight: 700 }}>X</button>
          </div>
      )}

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

      <section style={{ display: "flex", gap: "24px", flexWrap: "wrap", zIndex: 10 }}>
        <GlowingStatCard title="Strategy Win Rate" value={data.apy} change="Variable" isPositive={true} icon={<TrendingUp />} accentColor="#ffffff" delay="0.1s" />
        <GlowingStatCard title="Cumulative 24h Volume" value={data.tvl} change="Live Routing" isPositive={true} icon={<AccountBalanceWallet />} accentColor="#b4b4c0" delay="0.2s" />
        <GlowingStatCard title="Total PnL Captured" value={data.emitted} change="Staking Rewards" isPositive={true} icon={<SwapCalls />} accentColor="#ffffff" delay="0.3s" />
        <GlowingStatCard title="Operations Executed" value={data.totalUsers} change="Jito Protected" isPositive={true} icon={<Public />} accentColor="#b4b4c0" delay="0.4s" />
      </section>

      {/* Vault Interactions */}
      <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "20px", display: "flex", gap: "32px", animationDelay: "0.45s", zIndex: 10 }}>
        {/* Deposit Block */}
        <div style={{ flex: 1, padding: "24px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "16px" }}>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "16px" }}>Deposit USDC</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
               <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                  <span>Amount to stake</span>
                  <span>Balance: {connected ? "1,540.00 USDC" : "0.00 USDC"}</span>
               </div>
               <div style={{ position: "relative" }}>
                   <input 
                      type="number" 
                      value={depositAmount} 
                      onChange={(e) => setDepositAmount(e.target.value)} 
                      placeholder="0.00" 
                      style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "#fff", padding: "16px", borderRadius: "12px", outline: "none", fontSize: "1.2rem", fontWeight: 700 }} 
                   />
                   <span style={{ position: "absolute", right: "16px", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)", fontWeight: 800 }}>USDC</span>
               </div>
               <button onClick={handleDeposit} className="neon-btn" style={{ background: "var(--success)", color: "#000", padding: "16px", borderRadius: "12px", fontWeight: 800, fontSize: "1.05rem", border: "none", cursor: "pointer", marginTop: "8px", boxShadow: "0 0 15px rgba(0, 255, 170, 0.4)" }}>
                   Stake & Mint $PCP
               </button>
               <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textAlign: "center", marginTop: "4px" }}>You will receive approximately {depositAmount ? (Number(depositAmount) * 0.98).toFixed(2) : "0.00"} $PCP based on current pool exchange rate.</p>
            </div>
        </div>

        {/* Withdraw Block */}
        <div style={{ flex: 1, padding: "24px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "16px" }}>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "16px" }}>Withdraw base asset</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
               <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                  <span>Amount to withdraw ($PCP to burn)</span>
                  <span>Staked: {connected ? "420.50 $PCP" : "0.00 $PCP"}</span>
               </div>
               <div style={{ position: "relative" }}>
                   <input 
                      type="number" 
                      value={withdrawAmount} 
                      onChange={(e) => setWithdrawAmount(e.target.value)} 
                      placeholder="0.00" 
                      style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "#fff", padding: "16px", borderRadius: "12px", outline: "none", fontSize: "1.2rem", fontWeight: 700 }} 
                   />
                   <span style={{ position: "absolute", right: "16px", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)", fontWeight: 800 }}>$PCP</span>
               </div>
               <button onClick={handleWithdraw} className="neon-btn" style={{ background: "var(--error)", color: "#fff", padding: "16px", borderRadius: "12px", fontWeight: 800, fontSize: "1.05rem", border: "none", cursor: "pointer", marginTop: "8px", boxShadow: "0 0 15px rgba(255, 51, 102, 0.4)" }}>
                   Unstake base asset
               </button>
               <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textAlign: "center", marginTop: "4px" }}>A 0.5% unstaking fee applies to withdrawals to protect pool yield.</p>
            </div>
        </div>
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
            {(data.recentLogs.length ? data.recentLogs : [{ id: 0, route: "Awaiting blocks...", status: "POLLING", profit: "-", ok: true, hash: "..." }]).map((log: any) => (
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
          </div>
        </section>
      </div>
    </div>
  );
}
