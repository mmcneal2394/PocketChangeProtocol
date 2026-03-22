"use client";

import { CheckCircleOutline, VpnKey, Speed, AccountCircle, Update, WarningAmber } from "@mui/icons-material";
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

const PCP_MINT = "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";

function BillingContent() {
  const searchParams = useSearchParams();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.5s ease" }}>
      <header>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px" }}>Tokenomics &amp; Mechanics</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>
          $PCP is the economic backbone of the protocol. We pool user funds and leverage advanced execution strategies
          natively built on Solana to democratize access to high-frequency arbitrage profits.
        </p>
      </header>

      {/* $PCP Structure */}
      <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", borderTop: "2px solid var(--primary)" }}>
        <div>
          <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600, letterSpacing: "1px", marginBottom: "8px" }}>Ecosystem Governance</p>
          <h2 style={{ fontSize: "2.5rem", fontWeight: 800, color: "#fff", display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>$PCP Structure</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
              <AccountCircle style={{ color: "var(--primary)" }} /> Liquid Staking enabled for $PCP / USDC
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
              <Speed style={{ color: "var(--primary)" }} /> Sub-second finality via Jito bundles
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
              <WarningAmber style={{ color: "var(--primary)" }} /> Mint/Freeze authorities permanently renounced
            </div>
          </div>
        </div>

        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.1)", paddingLeft: "32px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <h3 style={{ fontSize: "1.2rem", color: "#fff", marginBottom: "16px" }}>Protocol Value Distribution</h3>
          <div style={{ marginBottom: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Total Arbitrage Executed</span>
              <span style={{ fontWeight: 600, color: "var(--success)" }}>+$54,233.21 (30D)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Staking Rewards (80%)</span>
              <span style={{ fontWeight: 600 }}>+$43,386.56</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>DAO Treasury/Buybacks (20%)</span>
              <span style={{ fontWeight: 600, color: "var(--secondary)" }}>+$10,846.65</span>
            </div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "16px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid rgba(255,255,255,0.15)" }}>
            <Update />
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Yields mapped directly to Programmable Transaction Blocks (PTBs). <strong style={{ color: "#fff" }}>Atomic guarantees enforced.</strong>
            </p>
          </div>
        </div>
      </section>

      {/* ── BUY $PCP ON BAGS.FM ──────────────────────────────────────────────── */}
      <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "2px solid rgba(138,43,226,0.5)", background: "linear-gradient(135deg, rgba(138,43,226,0.12), rgba(0,0,0,0.5))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "24px" }}>
          <span style={{ fontSize: "2.5rem" }}>🛍</span>
          <div>
            <h2 style={{ fontSize: "1.8rem", fontWeight: 800, marginBottom: "4px" }}>Get $PCP Now</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              Available on Bags.fm — the fastest way to acquire $PCP on Solana
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "16px", color: "var(--primary)" }}>
              How to Buy on Bags.fm
            </h3>
            <ol style={{ padding: "0 0 0 20px", display: "flex", flexDirection: "column", gap: "12px", color: "var(--text-secondary)", lineHeight: 1.7 }}>
              <li>
                <strong style={{ color: "#fff" }}>Connect your Phantom wallet</strong> at{" "}
                <a href="https://bags.fm" target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)" }}>bags.fm</a>
              </li>
              <li><strong style={{ color: "#fff" }}>Search for "PCP"</strong> or click the direct link</li>
              <li><strong style={{ color: "#fff" }}>Enter the amount</strong> of SOL you want to swap</li>
              <li><strong style={{ color: "#fff" }}>Confirm in your wallet</strong> — $PCP arrives instantly</li>
            </ol>
            <div style={{ marginTop: "20px", padding: "12px 16px", background: "rgba(0,0,0,0.4)", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.08)", fontFamily: "monospace", fontSize: "0.78rem", color: "#999", wordBreak: "break-all" }}>
              Mint: <span style={{ color: "var(--primary)" }}>{PCP_MINT}</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <a
              href="https://bags.fm/t/PCP"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", padding: "20px", background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", borderRadius: "14px", textDecoration: "none", fontSize: "1.15rem", fontWeight: 800, textAlign: "center", border: "1px solid rgba(138,43,226,0.5)", boxShadow: "0 8px 32px rgba(138,43,226,0.35)" }}
            >
              🛍 Buy $PCP on Bags.fm →
            </a>
            <a
              href={`https://jup.ag/swap/SOL-${PCP_MINT}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", padding: "14px", background: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", borderRadius: "12px", textDecoration: "none", fontSize: "0.95rem", fontWeight: 600, textAlign: "center", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              Also available on Jupiter Swap →
            </a>
            <div style={{ textAlign: "center", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.8 }}>
              <p>✅ Mint/Freeze authorities permanently renounced</p>
              <p>🔒 Fixed supply: 1,000,000,000 $PCP total</p>
            </div>
          </div>
        </div>
      </section>

      {/* Atomic Security Guarantees */}
      <div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "24px" }}>Atomic Security Guarantees</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "24px" }}>
          <div className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.15)" }}>
            <h3 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "8px" }}>Zero-Risk Alpha Execution</h3>
            <p style={{ color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: "24px", maxWidth: "800px" }}>
              Instead of relying on latency arms-races, the PocketChange Vault utilizes atomic constraints alongside
              deep-liquidity routes ensuring absolute positive expected value.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", marginBottom: "32px" }}>
              <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleOutline style={{ color: "var(--primary)" }} />
                Programmable Transaction Blocks (PTBs) ensure all swaps succeed atomically, reverting instantly if conditions fail.
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleOutline style={{ color: "var(--primary)" }} />
                Jito Integration protects transactions via private mempools, preventing sandwich attacks &amp; MEV front-running.
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "8px", color: "#fff", fontWeight: 600 }}>
                <VpnKey style={{ color: "var(--primary)" }} />
                Smart Contracts are Non-Custodial. The vault retains multi-sig limits where admins cannot drain funds.
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleOutline style={{ color: "var(--primary)" }} />
                Focus solely on delta-neutral strategies, stablecoin arbitrage, and event-driven liquidations.
              </li>
            </ul>
            <div style={{ padding: "16px 24px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--success)", fontWeight: 600 }}>
              <CheckCircleOutline /> Protocol Secured: PTB Contracts Active
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div style={{ color: "white", padding: "40px" }}>Loading Protocol Mechanics...</div>}>
      <BillingContent />
    </Suspense>
  );
}
