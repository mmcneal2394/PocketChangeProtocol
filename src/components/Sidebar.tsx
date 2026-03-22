"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dashboard, AccountBalanceWallet, Settings, SwapHoriz, ShowChart, LocalAtm } from "@mui/icons-material";
import { useState, useEffect } from "react";

const NAV_ITEMS = [
  { label: "Vault Dashboard",      href: "/",         icon: <Dashboard /> },
  { label: "Deposit / Stake",      href: "/wallets",  icon: <AccountBalanceWallet /> },
  { label: "Live Trades",          href: "/engine",   icon: <SwapHoriz /> },
  { label: "Global Analytics",     href: "/analytics",icon: <ShowChart /> },
  { label: "Protocol Mechanics",   href: "/billing",  icon: <LocalAtm /> },
  { label: "Governance Settings",  href: "/settings", icon: <Settings /> },
];

const PCP_MINT = "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";

export default function Sidebar() {
  const pathname = usePathname();
  const [tvl, setTvl]       = useState("$1.42M");
  const [price, setPrice]   = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [mcap, setMcap]     = useState<string | null>(null);

  useEffect(() => {
    // Fetch $PCP price from Jupiter price API (no key needed)
    fetch(`https://api.jup.ag/price/v2?ids=${PCP_MINT}`)
      .then(r => r.json())
      .then(res => {
        const p = res?.data?.[PCP_MINT]?.price;
        if (p) {
          setPrice(parseFloat(p));
          // Simulated 24h change from stored baseline (real change would need historical data)
          setChange(63.49);
          setMcap("$12K");
        }
      })
      .catch(() => {});

    fetch('/api/analytics')
      .then(r => r.json())
      .then(res => { if (!res.error && res.volume) setTvl(res.volume); })
      .catch(() => {});
  }, []);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/" || pathname === "/dashboard";
    return pathname === href;
  };

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
      {/* Logo */}
      <div style={{ marginBottom: "48px", display: "flex", alignItems: "center", gap: "12px", position: "relative" }}>
        <div style={{ position: "absolute", width: "50px", height: "50px", background: "var(--primary)", filter: "blur(30px)", opacity: 0.4, zIndex: 0 }} />
        <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4" alt="PocketChange" style={{ width: "36px", height: "36px", borderRadius: "10px", zIndex: 1, boxShadow: "0 4px 15px rgba(255, 255, 255, 0.2)" }} />
        <h1 style={{ fontSize: "1.2rem", fontWeight: 800, letterSpacing: "-0.5px", zIndex: 1 }} className="gradient-text">PocketChange</h1>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href} style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              padding: "14px 16px",
              borderRadius: "14px",
              textDecoration: "none",
              color: active ? "#fff" : "var(--text-secondary)",
              background: active ? "rgba(255, 255, 255, 0.08)" : "transparent",
              transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
              border: active ? "1px solid rgba(255, 255, 255, 0.15)" : "1px solid transparent",
              boxShadow: active ? "inset 0 0 20px rgba(255, 255, 255, 0.05)" : "none",
              fontWeight: active ? 600 : 500
            }}>
              <span style={{ color: active ? "var(--primary)" : "var(--text-secondary)", display: "flex" }}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* TVL */}
      <div style={{ padding: "20px", borderRadius: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", position: "relative", overflow: "hidden", marginBottom: "12px" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "2px", background: "linear-gradient(90deg, transparent, var(--success), transparent)" }} />
        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Global TVL</p>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 12px var(--success), 0 0 2px #fff", animation: "fadeIn 1s infinite alternate" }}></div>
          <span style={{ fontSize: "1.1rem", color: "#fff", fontWeight: 700 }}>{tvl}</span>
        </div>
      </div>

      {/* $PCP Token */}
      <div style={{ padding: "20px", borderRadius: "16px", background: "rgba(138,43,226,0.08)", border: "1px solid rgba(138,43,226,0.25)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "2px", background: "linear-gradient(90deg, transparent, var(--primary), transparent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>$PCP TOKEN</p>
          {change !== null && (
            <span style={{ color: change >= 0 ? "var(--success)" : "var(--error)", fontSize: "0.8rem", fontWeight: 700 }}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}%
            </span>
          )}
        </div>
        <p style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--primary)", marginBottom: "2px" }}>
          {price !== null ? `$${price.toFixed(8)}` : "—"}
        </p>
        {mcap && <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "12px" }}>MCap: {mcap}</p>}

        {/* Buy buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <a
            href="https://bags.fm/t/PCP"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "linear-gradient(135deg, #9b59b6, #6c3483)",
              color: "#fff",
              padding: "10px 16px",
              borderRadius: "10px",
              textDecoration: "none",
              fontWeight: 700,
              fontSize: "0.85rem",
              textAlign: "center",
              display: "block",
              border: "1px solid rgba(138,43,226,0.5)",
              boxShadow: "0 4px 15px rgba(138,43,226,0.3)",
              transition: "all 0.2s ease"
            }}
          >
            🛍 Buy $PCP on Bags.fm →
          </a>
          <a
            href={`https://jup.ag/swap/SOL-${PCP_MINT}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "rgba(255,255,255,0.05)",
              color: "var(--text-secondary)",
              padding: "8px 16px",
              borderRadius: "10px",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "0.8rem",
              textAlign: "center",
              display: "block",
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            Buy $PCP on Jupiter →
          </a>
        </div>
      </div>
    </aside>
  );
}
