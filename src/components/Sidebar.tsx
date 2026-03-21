"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Dashboard, AccountBalanceWallet, Settings, FlashOn, ShowChart, LocalAtm } from "@mui/icons-material";

const NAV_ITEMS = [
  { label: "Vault Dashboard",    href: "/",          icon: <Dashboard /> },
  { label: "Deposit / Stake",    href: "/wallets",   icon: <AccountBalanceWallet /> },
  { label: "Live Trades",        href: "/engine",    icon: <FlashOn /> },
  { label: "Global Analytics",   href: "/analytics", icon: <ShowChart /> },
  { label: "Protocol Mechanics", href: "/billing",   icon: <LocalAtm /> },
  { label: "Governance Settings",href: "/settings",  icon: <Settings /> },
];

// $PCP token mint — update once token launches
const PCP_MINT = process.env.NEXT_PUBLIC_PCP_MINT || "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";

interface PcpPrice {
  price: number | null;
  change24h: number | null;
  mcap: number | null;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [pcp, setPcp] = useState<PcpPrice>({ price: null, change24h: null, mcap: null });

  useEffect(() => {
    async function fetchPcp() {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${PCP_MINT}`);
        const j = await res.json();
        const pair = j?.pairs?.[0];
        if (pair) {
          setPcp({
            price:    parseFloat(pair.priceUsd ?? "0"),
            change24h:pair.priceChange?.h24 ?? null,
            mcap:     pair.marketCap ?? null,
          });
        }
      } catch { /* ignore */ }
    }
    fetchPcp();
    const iv = setInterval(fetchPcp, 30_000);
    return () => clearInterval(iv);
  }, []);

  const changeColor = pcp.change24h === null ? "#64748b" : pcp.change24h >= 0 ? "#34d399" : "#f87171";

  return (
    <aside style={{
      width: "280px",
      minHeight: "100vh",
      borderRight: "1px solid rgba(255, 255, 255, 0.1)",
      display: "flex",
      flexDirection: "column",
      padding: "32px 24px",
      position: "fixed",
      zIndex: 100,
      background: "rgba(10, 10, 12, 0.7)",
      backdropFilter: "blur(24px)",
      boxShadow: "10px 0 30px rgba(0,0,0,0.5)"
    }}>
      <div style={{ marginBottom: "48px", display: "flex", alignItems: "center", gap: "12px", position: "relative" }}>
        <div style={{ position: "absolute", width: "50px", height: "50px", background: "var(--primary)", filter: "blur(30px)", opacity: 0.4, zIndex: 0 }} />
        <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4" alt="PocketChange" style={{ width: "36px", height: "36px", borderRadius: "10px", zIndex: 1, boxShadow: "0 4px 15px rgba(255, 255, 255, 0.2)" }} />
        <h1 style={{ fontSize: "1.2rem", fontWeight: 800, letterSpacing: "-0.5px", zIndex: 1 }} className="gradient-text">PocketChange</h1>
      </div>

      <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href} style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              padding: "14px 16px",
              borderRadius: "14px",
              textDecoration: "none",
              color: isActive ? "#fff" : "var(--text-secondary)",
              background: isActive ? "rgba(255, 255, 255, 0.08)" : "transparent",
              transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
              border: isActive ? "1px solid rgba(255, 255, 255, 0.15)" : "1px solid transparent",
              boxShadow: isActive ? "inset 0 0 20px rgba(255, 255, 255, 0.05)" : "none",
              fontWeight: isActive ? 600 : 500
            }}>
              <span style={{ color: isActive ? "var(--primary)" : "var(--text-secondary)", display: "flex" }}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Global TVL */}
      <div style={{ padding: "20px", borderRadius: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", position: "relative", overflow: "hidden", marginBottom: "12px" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "2px", background: "linear-gradient(90deg, transparent, var(--success), transparent)" }} />
        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Global TVL</p>
        <div style={{ display: "flex", alignItems: "center", justifyItems: "center", gap: "10px" }}>
          <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 12px var(--success), 0 0 2px #fff", animation: "fadeIn 1s infinite alternate" }}></div>
          <span style={{ fontSize: "1.1rem", color: "#fff", fontWeight: 700 }}>$1.42M</span>
        </div>
      </div>

      {/* $PCP Token Widget */}
      <div style={{ padding: "16px", borderRadius: "16px", background: "linear-gradient(135deg, rgba(167,139,250,0.06), rgba(52,211,153,0.04))", border: "1px solid rgba(167,139,250,0.15)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "2px", background: "linear-gradient(90deg, transparent, #a78bfa, transparent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>$PCP Token</p>
          {pcp.change24h !== null && (
            <span style={{ fontSize: "0.7rem", fontWeight: 700, color: changeColor }}>
              {pcp.change24h >= 0 ? "+" : ""}{pcp.change24h.toFixed(2)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "#a78bfa", marginBottom: "4px" }}>
          {pcp.price !== null ? `$${pcp.price.toFixed(6)}` : "—"}
        </div>
        {pcp.mcap !== null && (
          <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", marginBottom: "10px" }}>
            MCap: ${(pcp.mcap / 1_000).toFixed(0)}K
          </div>
        )}
        <a
          href={`https://jup.ag/swap/SOL-${PCP_MINT}`}
          target="_blank"
          rel="noopener"
          style={{ display: "block", textAlign: "center", padding: "8px", borderRadius: "10px", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontWeight: 700, fontSize: "0.8rem", textDecoration: "none", transition: "all 0.2s" }}
        >
          Buy $PCP on Jupiter →
        </a>
      </div>
    </aside>
  );
}
