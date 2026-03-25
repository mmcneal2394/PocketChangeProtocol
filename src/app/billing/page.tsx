"use client";

import { CheckCircleOutline, VpnKey, Speed, AccountCircle, Update, WarningAmber } from "@mui/icons-material";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

import { Suspense } from 'react';

function BillingContent() {
  const searchParams = useSearchParams();
  const isMockCheckout = searchParams.get("mock_checkout");
  const isSuccess = searchParams.get("success");

  const [loadingTier, setLoadingTier] = useState<string | null>(null);

  const startCheckout = async (planId: "PRO" | "ENTERPRISE", maxWallets: number) => {
      setLoadingTier(planId);
      try {
          const res = await fetch("/api/billing", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ planId, maxWallets })
          });
          
          const data = await res.json();
          if (data.url) {
              window.location.href = data.url; 
          }
      } catch (e) {
          console.error(e);
      } finally {
          setLoadingTier(null);
      }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.5s ease" }}>
      <header>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px" }}>Tokenomics & Mechanics</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>
          $PCP is the economic backbone of the protocol. We pool user funds and leverage advanced execution strategies natively built on Solana to democratize access to high-frequency arbitrage profits.
        </p>
      </header>

      {/* Current Plan Overview */}
      <section className="glassmorphism fade-in billing-overview" style={{ padding: "32px", borderRadius: "16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", borderTop: "2px solid var(--primary)" }}>
          <div>
              <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600, letterSpacing: "1px", marginBottom: "8px" }}>
                  Ecosystem Governance
              </p>
              <h2 style={{ fontSize: "2.5rem", fontWeight: 800, color: "#fff", display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
                  $PCP Structure
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
                      <AccountCircle style={{ color: "var(--primary)" }} /> Liquid Staking enabled for $PCP / USDC
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
                      <Speed style={{ color: "var(--primary)" }} /> Sub-second finality via Jito bundles
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
                      <WarningAmber style={{ color: "var(--primary)" }} /> Mint/Freeze authorities renounced
                  </div>
              </div>
          </div>

          <div className="billing-divider" style={{ borderLeft: "1px solid rgba(255,255,255,0.1)", paddingLeft: "32px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
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

              <div style={{ background: "rgba(255, 255, 255, 0.05)", padding: "16px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid rgba(255, 255, 255, 0.15)" }}>
                  <Update />
                  <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                      Yields mapped directly to Programmable Transaction Blocks (PTBs). <strong style={{ color: "#fff" }}>Atomic guarantees enforced.</strong>
                  </p>
              </div>
          </div>
      </section>

      {/* Pricing Upgrade Logic */}
      <div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "24px" }}>Atomic Security Guarantees</h2>
        
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "24px" }}>
             
             {/* WEB3 Mechanics Card */}
             <div className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.15)" }}>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "8px" }}>Zero-Risk Alpha Execution</h3>
                  <p style={{ color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: "24px", maxWidth: "800px" }}>
                      Instead of relying on latency arms-races, the PocketChange Vault utilizes atomic constraints alongside deep-liquidity routes ensuring absolute positive expected value. Here is how the engine protects staker capital:
                  </p>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", marginBottom: "32px" }}>
                      <li style={{ display: "flex", alignItems: "center", gap: "8px" }}><CheckCircleOutline style={{ color: "var(--primary)" }} /> Programmable Transaction Blocks (PTBs) ensures all swaps succeed atomically, reverting instantly if conditions fail.</li>
                      <li style={{ display: "flex", alignItems: "center", gap: "8px" }}><CheckCircleOutline style={{ color: "var(--primary)" }} /> Jito Integration protects retail transactions via private mempools, preventing sandwich attacks & MEV front-running.</li>
                      <li style={{ display: "flex", alignItems: "center", gap: "8px", color: "#fff", fontWeight: 600 }}><VpnKey style={{ color: "var(--primary)" }} /> Smart Contracts are Non-Custodial. The vault retains multi-sig limits where admins cannot drain funds, only automate yield.</li>
                      <li style={{ display: "flex", alignItems: "center", gap: "8px" }}><CheckCircleOutline style={{ color: "var(--primary)" }} /> Focus solely on delta-neutral strategies, stablecoin arbitrage, and prediction-market event-driven liquidations.</li>
                  </ul>
                  
                  <button 
                    style={{
                      padding: "16px 24px", background: "rgba(255,255,255,0.05)",
                      color: "var(--text-primary)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", fontWeight: 600, cursor: "not-allowed"
                  }}>
                      Protocol Secured: PTB Contracts Active
                  </button>
             </div>

        </div>
      </div>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div style={{ color: "white" }}>Loading Billing Portal...</div>}>
      <BillingContent />
    </Suspense>
  );
}
