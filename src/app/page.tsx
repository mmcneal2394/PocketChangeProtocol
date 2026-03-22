"use client";

import Link from "next/link";
import { ArrowForward, LocalAtm, Security, Speed, TrendingUp, DeveloperMode, SyncAlt, AccountBalanceWallet } from "@mui/icons-material";
import { useEffect, useState } from "react";

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return (
    <div style={{ minHeight: "100vh", position: "relative", overflowX: "hidden", color: "#fff" }}>
      {/* Background Ambience */}
      <div className="glow-orb glow-orb-primary" style={{ top: "-10%", left: "-10%", width: "600px", height: "600px", animationDuration: "20s" }} />
      <div className="glow-orb glow-orb-secondary" style={{ top: "40%", right: "-20%", width: "800px", height: "800px", animationDuration: "25s", animationDirection: "reverse" }} />
      
      {/* Navbar */}
      <nav style={{ padding: "24px 48px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "absolute", top: 0, width: "100%", zIndex: 100, background: "linear-gradient(180deg, rgba(0,0,0,0.8), transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
           <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4" alt="Logo" style={{ width: "40px", height: "40px", borderRadius: "12px", boxShadow: "0 4px 20px rgba(255, 255, 255, 0.2)" }} />
           <span style={{ fontSize: "1.4rem", fontWeight: 800, letterSpacing: "-0.5px" }} className="gradient-text">PocketChange Protocol</span>
        </div>
        <div style={{ display: "flex", gap: "24px", fontSize: "0.9rem", fontWeight: 600 }}>
           <a href="#features" style={{ color: "var(--text-secondary)", textDecoration: "none" }}>Platform</a>
           <a href="#security" style={{ color: "var(--text-secondary)", textDecoration: "none" }}>Security</a>
           <Link href="/vault" style={{ color: "var(--text-secondary)", textDecoration: "none" }}>Vault Portal</Link>
           <Link href="/admin" style={{ color: "#9b59b6", textDecoration: "none", fontWeight: 700 }}>⚙ Admin</Link>
        </div>
        <div>
           <Link href="/vault" style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.05))", border: "1px solid rgba(255,255,255,0.2)", padding: "12px 24px", borderRadius: "10px", color: "#fff", textDecoration: "none", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px", boxShadow: "0 4px 15px rgba(255, 255, 255, 0.1)" }}>
               Enter Vault <ArrowForward fontSize="small" />
           </Link>
        </div>
      </nav>

      <main style={{ maxWidth: "1200px", margin: "0 auto", padding: "160px 24px 80px 24px", zIndex: 10, position: "relative" }}>
        
        {/* Hero Section */}
        <section style={{ textAlign: "center", marginBottom: "120px", display: "flex", flexDirection: "column", alignItems: "center" }}>
           <div style={{ padding: "8px 16px", background: "rgba(0, 255, 170, 0.1)", color: "var(--success)", border: "1px solid var(--success)", borderRadius: "20px", fontSize: "0.85rem", fontWeight: 700, letterSpacing: "1px", marginBottom: "24px", animation: "fadeIn 1s ease" }}>
               ⚡ JITO MEV PROTECTION ACTIVE
           </div>
           <h1 style={{ fontSize: "5rem", fontWeight: 900, lineHeight: 1.1, letterSpacing: "-2.5px", marginBottom: "24px", animation: "slideUp 1s cubic-bezier(0.16, 1, 0.3, 1)" }}>
               Institutional-Grade <br/>
               <span className="gradient-text" style={{ textShadow: "0 0 40px rgba(138,43,226,0.4)" }}>Arbitrage Yields.</span>
           </h1>
           <p style={{ fontSize: "1.25rem", color: "var(--text-secondary)", maxWidth: "700px", margin: "0 auto 48px auto", lineHeight: 1.6, animation: "slideUp 1.2s cubic-bezier(0.16, 1, 0.3, 1)" }}>
               Deposit crypto capital and watch the Pocket Money Protocol deploy atomic flash loans targeting DEX inefficiencies simultaneously. Zero capital risk. Absolute delta-neutral mapping.
           </p>

           <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", justifyContent: "center", animation: "slideUp 1.4s cubic-bezier(0.16, 1, 0.3, 1)" }}>
               <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" className="neon-btn" style={{ background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", padding: "20px 48px", borderRadius: "16px", textDecoration: "none", fontSize: "1.2rem", fontWeight: 800, border: "1px solid rgba(138,43,226,0.5)", boxShadow: "0 8px 32px rgba(138,43,226,0.4)" }}>
                   🛍 Buy $PCP on Bags.fm
               </a>
               <Link href="/wallets" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.2)", padding: "20px 48px", borderRadius: "16px", color: "#fff", textDecoration: "none", fontSize: "1.2rem", fontWeight: 700 }}>
                   Enter Vault →
               </Link>
           </div>

           {/* Hero HUD Elements */}
           <div className="glassmorphism fade-in" style={{ marginTop: "80px", width: "100%", padding: "24px", borderRadius: "24px", border: "1px solid rgba(255,255,255,0.1)", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "24px", background: "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(0,0,0,0.5))" }}>
               <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                   <p style={{ color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85rem", letterSpacing: "1px" }}>Global TVL</p>
                   <p style={{ fontSize: "2.5rem", fontWeight: 800 }}>$1.42M</p>
               </div>
               <div style={{ display: "flex", flexDirection: "column", alignItems: "center", borderLeft: "1px solid rgba(255,255,255,0.1)", borderRight: "1px solid rgba(255,255,255,0.1)" }}>
                   <p style={{ color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85rem", letterSpacing: "1px" }}>Execution Latency</p>
                   <p style={{ fontSize: "2.5rem", fontWeight: 800, color: "var(--success)" }}>35ms</p>
               </div>
               <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                   <p style={{ color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85rem", letterSpacing: "1px" }}>Total Volume (30D)</p>
                   <p style={{ fontSize: "2.5rem", fontWeight: 800 }}>$840.2M</p>
               </div>
           </div>
        </section>

        {/* Features Split */}
        <section id="features" style={{ marginBottom: "120px" }}>
            <div style={{ display: "flex", gap: "64px", alignItems: "center", marginBottom: "64px" }}>
                <div style={{ flex: 1, paddingRight: "32px" }}>
                    <h2 style={{ fontSize: "2.8rem", fontWeight: 800, letterSpacing: "-1px", marginBottom: "24px", lineHeight: 1.1 }}>
                        Unrivaled Atomic Execution
                    </h2>
                    <p style={{ color: "var(--text-secondary)", fontSize: "1.1rem", lineHeight: 1.7, marginBottom: "32px" }}>
                        We leverage Solana's Programmable Transaction Blocks (PTB). Our Rust-based engine wraps DEX multi-hops inside a single signed instruction. If the yield slippage requirement fails, the transaction is rejected off-chain, costing 0 gas.
                    </p>
                    <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "16px" }}>
                        <li style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "1.05rem", fontWeight: 500 }}><CheckIcon color="var(--primary)" /> 45,000 TPS Maximum Bandwidth</li>
                        <li style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "1.05rem", fontWeight: 500 }}><CheckIcon color="var(--primary)" /> Flash-loans deployed globally</li>
                        <li style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "1.05rem", fontWeight: 500 }}><CheckIcon color="var(--primary)" /> Non-custodial Smart Contract Multi-signs</li>
                    </ul>
                </div>
                <div style={{ flex: 1 }}>
                    <div className="glassmorphism" style={{ padding: "40px", borderRadius: "24px", background: "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(138,43,226,0.15))", 
                          border: "1px solid rgba(138,43,226,0.4)", position: "relative" }}>
                        <Speed style={{ fontSize: "4rem", color: "var(--primary)", marginBottom: "24px" }} />
                        <h3 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "16px" }}>Rust Backend Execution</h3>
                        <p style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>We built our core bot natively in Rust utilizing multithreaded Rayon constraints. This bypasses the standard Web3.js UI latency entirely.</p>
                        
                        <div style={{ marginTop: "24px", padding: "16px", background: "rgba(0,0,0,0.5)", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)", fontFamily: "monospace", color: "var(--success)" }}>
                            <p>[Engine] Jupiter DEX Poller active.</p>
                            <p>[Block 420993] +$1.02 USDC Profit Found!</p>
                            <p>[Exec] Jito Bundle Signed.</p>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        {/* Feature Grid */}
        <section style={{ marginBottom: "120px" }}>
             <h2 style={{ textAlign: "center", fontSize: "2.5rem", fontWeight: 800, marginBottom: "64px" }}>Engineered for Total Sovereignty</h2>
             <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "32px" }}>
                 <FeatureCard icon={<Security style={{ color: "var(--success)", fontSize: "2.5rem" }}/>} title="KMS Payload Matrix" desc="Enterprise-grade Master Key decryption handled locally. Hackers accessing the remote node still fail to sign." />
                 <FeatureCard icon={<LocalAtm style={{ color: "var(--secondary)", fontSize: "2.5rem" }}/>} title="Yield Splitting (80/20)" desc="Depositors keep 80% of generated gross yield. The protocol treasury claims a standard 20% maintenance cut." />
                 <FeatureCard icon={<DeveloperMode style={{ color: "var(--primary)", fontSize: "2.5rem" }}/>} title="API Access Webhooks" desc="Deploy enterprise signals. React programmatically every time the system lands a multi-tier flash liquidation." />
                 <FeatureCard icon={<SyncAlt style={{ color: "#29b6f6", fontSize: "2.5rem" }}/>} title="Auto-Compounding" desc="$PCP token values inflate directly alongside the growing USDC treasury base value, requiring zero interaction." />
                 <FeatureCard icon={<TrendingUp style={{ color: "var(--primary)", fontSize: "2.5rem" }}/>} title="Jito Network Routing" desc="Transactions bypass public RPCs. MEV block-builders drop our routes simultaneously, eliminating sandwiching." />
                 <FeatureCard icon={<AccountBalanceWallet style={{ color: "#ab47bc", fontSize: "2.5rem" }}/>} title="Native Integrations" desc="Phantom, Solflare, WalletConnect. Simply sign an Anchor BPF limit to lock your base capital natively." />
             </div>
        </section>

        {/* CTA */}
        <section style={{ textAlign: "center", padding: "80px", borderRadius: "32px", background: "linear-gradient(135deg, rgba(138,43,226,0.3), rgba(0,0,0,0.5))", border: "1px solid rgba(255,255,255,0.15)", position: "relative", overflow: "hidden" }}>
             <div className="glow-orb glow-orb-primary" style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "400px", height: "400px" }} />
             <h2 style={{ fontSize: "3rem", fontWeight: 900, marginBottom: "24px", position: "relative", zIndex: 10 }}>Ready to capture the spreads?</h2>
             <p style={{ fontSize: "1.2rem", color: "var(--text-secondary)", marginBottom: "40px", maxWidth: "600px", margin: "0 auto 40px auto", position: "relative", zIndex: 10 }}>Zero maintenance required. Deposit liquidity, wait, and burn your mapping tokens for pure profit withdrawals.</p>
             <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" className="neon-btn" style={{ position: "relative", zIndex: 10, background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", padding: "20px 48px", borderRadius: "16px", textDecoration: "none", fontSize: "1.2rem", fontWeight: 800, border: "1px solid rgba(138,43,226,0.5)", boxShadow: "0 8px 32px rgba(138,43,226,0.4)" }}>
                   🛍 Buy $PCP on Bags.fm
             </a>
        </section>
      </main>
      
      {/* Footer */}
      <footer style={{ padding: "48px 24px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>&copy; 2026 PocketChange Protocol. Powered by Solana &amp; Jito MEV.</p>
      </footer>
    </div>
  );
}

function CheckIcon({ color }: { color: string }) {
    return (
        <svg fill={color} width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
    )
}

function FeatureCard({ icon, title, desc }: any) {
    return (
        <div className="glassmorphism" style={{ padding: "32px", borderRadius: "20px", border: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: "16px", transition: "transform 0.3s ease", cursor: "pointer" }} onMouseOver={e => e.currentTarget.style.transform = 'translateY(-5px)'} onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}>
            {icon}
            <h3 style={{ fontSize: "1.3rem", fontWeight: 700 }}>{title}</h3>
            <p style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>{desc}</p>
        </div>
    )
}
