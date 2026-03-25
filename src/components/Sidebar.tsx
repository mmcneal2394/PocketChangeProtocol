"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dashboard, AccountBalanceWallet, Settings, SwapHoriz, ShowChart, LocalAtm, Close } from "@mui/icons-material";
import { useState, useEffect } from "react";

const NAV_ITEMS = [
  { label: "Vault Dashboard", href: "/dashboard", icon: <Dashboard /> },
  { label: "Deposit / Stake", href: "/wallets", icon: <AccountBalanceWallet /> },
  { label: "Yield Strategies", href: "/engine", icon: <SwapHoriz /> },
  { label: "Global Analytics", href: "/analytics", icon: <ShowChart /> },
  { label: "Protocol Mechanics", href: "/billing", icon: <LocalAtm /> },
  { label: "Governance Settings", href: "/settings", icon: <Settings /> },
];

export default function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [tvl, setTvl] = useState("$1.42M");

  useEffect(() => {
    fetch('/api/analytics').then(r => r.json()).then(res => {
        if (!res.error && res.volume) setTvl(res.volume);
    }).catch(() => {});
  }, []);

  return (
    <>
    <div className={`sidebar-overlay${isOpen ? ' active' : ''}`} onClick={onClose} />
    <aside className={`sidebar-mobile${isOpen ? ' open' : ''}`} style={{
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
        <button onClick={onClose} className="mobile-menu-btn" style={{ position: "absolute", right: "-12px", top: "-8px" }}>
          <Close />
        </button>
        <div style={{ position: "absolute", width: "50px", height: "50px", background: "var(--primary)", filter: "blur(30px)", opacity: 0.4, zIndex: 0 }} />
        <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4" alt="PocketChange" style={{ width: "36px", height: "36px", borderRadius: "10px", zIndex: 1, boxShadow: "0 4px 15px rgba(255, 255, 255, 0.2)" }} />
        <h1 style={{ fontSize: "1.2rem", fontWeight: 800, letterSpacing: "-0.5px", zIndex: 1 }} className="gradient-text">PocketChange</h1>
      </div>

      <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href} onClick={onClose} style={{
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

      <div style={{ padding: "20px", borderRadius: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "2px", background: "linear-gradient(90deg, transparent, var(--success), transparent)" }} />
        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Global TVL</p>
        <div style={{ display: "flex", alignItems: "center", justifyItems: "center", gap: "10px" }}>
          <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 12px var(--success), 0 0 2px #fff", animation: "fadeIn 1s infinite alternate" }}></div>
          <span style={{ fontSize: "1.1rem", color: "#fff", fontWeight: 700 }}>{tvl}</span>
        </div>
      </div>
    </aside>
    </>
  );
}
