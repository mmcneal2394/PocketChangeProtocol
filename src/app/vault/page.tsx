"use client";

import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AccountBalanceWallet, TrendingUp, Logout, ContentCopy, CheckCircle, Loop } from "@mui/icons-material";
import Link from "next/link";

// ── Simulated position data (replace with on-chain reads when funded) ─────────
const VAULT_APY = 12.5;
const PCP_MINT  = "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";

export default function VaultPortalPage() {
  const { publicKey, disconnect, connected } = useWallet();
  const { connection } = useConnection();

  const [balance, setBalance]       = useState<number | null>(null);
  const [pcpPrice, setPcpPrice]     = useState<number | null>(null);
  const [copied, setCopied]         = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawStatus, setWithdrawStatus] = useState<string | null>(null);
  const [mounted, setMounted]       = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Fetch SOL balance when wallet connects
  useEffect(() => {
    if (!publicKey || !connection) { setBalance(null); return; }
    connection.getBalance(publicKey)
      .then(b => setBalance(b / 1e9))
      .catch(() => setBalance(0));
  }, [publicKey, connection]);

  // Fetch live $PCP price
  useEffect(() => {
    fetch(`https://api.jup.ag/price/v2?ids=${PCP_MINT}`)
      .then(r => r.json())
      .then(d => { const p = d?.data?.[PCP_MINT]?.price; if (p) setPcpPrice(parseFloat(p)); })
      .catch(() => {});
  }, []);

  const copy = () => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleWithdraw = () => {
    setWithdrawing(true);
    setWithdrawStatus("Preparing withdrawal...");
    setTimeout(() => {
      setWithdrawStatus("Connect vault contract (coming soon — awaiting capital deployment)");
      setWithdrawing(false);
    }, 1500);
  };

  if (!mounted) return null;

  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(ellipse at top, rgba(138,43,226,0.15) 0%, #000 60%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: connected ? "flex-start" : "center",
      padding: "40px 24px",
      color: "#fff",
      fontFamily: "'Inter', sans-serif",
    }}>
      {/* Header */}
      <header style={{ width: "100%", maxWidth: "800px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "48px" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "10px", textDecoration: "none" }}>
          <img src="https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4"
            alt="PCP" style={{ width: "32px", height: "32px", borderRadius: "8px" }} />
          <span style={{ fontWeight: 800, fontSize: "1.1rem", color: "#9b59b6" }}>PocketChange</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {connected && (
            <button onClick={disconnect} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-secondary, #aaa)", padding: "8px 14px", borderRadius: "8px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
              <Logout fontSize="small" /> Disconnect
            </button>
          )}
          <WalletMultiButton style={{ background: "linear-gradient(135deg, #9b59b6, #6c3483)", border: "none", borderRadius: "10px", fontWeight: 700, fontSize: "0.9rem" }} />
        </div>
      </header>

      {!connected ? (
        /* ── CONNECT GATE ──────────────────────────────────────────────── */
        <div style={{ textAlign: "center", maxWidth: "480px" }}>
          <div style={{ width: "80px", height: "80px", borderRadius: "50%", background: "rgba(138,43,226,0.2)", border: "2px solid rgba(138,43,226,0.4)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 32px auto" }}>
            <AccountBalanceWallet style={{ fontSize: "2.5rem", color: "#9b59b6" }} />
          </div>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "16px" }}>Vault Portal</h1>
          <p style={{ color: "#888", lineHeight: 1.6, marginBottom: "40px" }}>
            Connect your Phantom or Solflare wallet to view your staked positions,
            earned yield, and withdraw your capital at any time.
          </p>
          <WalletMultiButton style={{ background: "linear-gradient(135deg, #9b59b6, #6c3483)", border: "none", borderRadius: "12px", fontWeight: 700, fontSize: "1rem", padding: "16px 48px", width: "100%" }} />
          <p style={{ marginTop: "24px", fontSize: "0.85rem", color: "#555" }}>
            Don&apos;t have $PCP yet?{" "}
            <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" style={{ color: "#9b59b6", textDecoration: "none", fontWeight: 600 }}>
              Buy on Bags.fm →
            </a>
          </p>
        </div>
      ) : (
        /* ── CONNECTED DASHBOARD ─────────────────────────────────────── */
        <div style={{ width: "100%", maxWidth: "800px", display: "flex", flexDirection: "column", gap: "24px" }}>

          {/* Wallet Identity Card */}
          <div style={{ background: "rgba(138,43,226,0.08)", border: "1px solid rgba(138,43,226,0.3)", borderRadius: "16px", padding: "24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ color: "#888", fontSize: "0.85rem", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "1px" }}>Connected Wallet</p>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontFamily: "monospace", fontSize: "1rem", color: "#9b59b6" }}>
                  {publicKey?.toString().slice(0, 8)}...{publicKey?.toString().slice(-6)}
                </span>
                <button onClick={copy} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", display: "flex", alignItems: "center" }}>
                  {copied ? <CheckCircle fontSize="small" style={{ color: "#00ff88" }} /> : <ContentCopy fontSize="small" />}
                </button>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ color: "#888", fontSize: "0.85rem", marginBottom: "4px" }}>SOL Balance</p>
              <p style={{ fontSize: "1.6rem", fontWeight: 800, color: "#00ff88" }}>
                {balance !== null ? `${balance.toFixed(4)} SOL` : "..."}
              </p>
            </div>
          </div>

          {/* Staked Position */}
          <div style={{ background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: "16px", padding: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
              <div>
                <p style={{ color: "#888", fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Your Vault Position</p>
                <h2 style={{ fontSize: "2rem", fontWeight: 800 }}>$0.00 USDC</h2>
                <p style={{ color: "#888", fontSize: "0.9rem", marginTop: "4px" }}>0 $PCP tokens held</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p style={{ color: "#00ff88", fontSize: "1.4rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>
                  <TrendingUp /> +{VAULT_APY}% APY
                </p>
                <p style={{ color: "#888", fontSize: "0.8rem", marginTop: "4px" }}>Variable · 24h active</p>
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "24px" }}>
              {[
                { label: "Earned (All Time)", val: "+$0.00", color: "#00ff88" },
                { label: "$PCP Price", val: pcpPrice ? `$${pcpPrice.toFixed(8)}` : "—", color: "#9b59b6" },
                { label: "Unbonding Period", val: "24h", color: "#fff" },
              ].map(s => (
                <div key={s.label} style={{ background: "rgba(0,0,0,0.3)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "6px" }}>{s.label}</p>
                  <p style={{ fontWeight: 700, color: s.color, fontSize: "1.1rem" }}>{s.val}</p>
                </div>
              ))}
            </div>

            {/* Deposit & Withdraw */}
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={() => window.open("https://bags.fm/t/PCP", "_blank")}
                style={{ flex: 1, padding: "14px", background: "linear-gradient(135deg, #9b59b6, #6c3483)", color: "#fff", border: "none", borderRadius: "12px", fontWeight: 700, cursor: "pointer", fontSize: "1rem" }}
              >
                🛍 Buy $PCP on Bags.fm
              </button>
              <button
                onClick={handleWithdraw}
                disabled={withdrawing}
                style={{ flex: 1, padding: "14px", background: "rgba(255,255,255,0.05)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "12px", fontWeight: 600, cursor: "pointer", fontSize: "1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
              >
                {withdrawing ? <Loop style={{ animation: "spin 1s linear infinite" }} /> : null}
                Withdraw Position
              </button>
            </div>
            {withdrawStatus && (
              <p style={{ marginTop: "12px", color: "#888", fontSize: "0.85rem", textAlign: "center" }}>{withdrawStatus}</p>
            )}
          </div>

          {/* Recent Activity */}
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "24px" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#9b59b6", display: "inline-block" }}></span>
              Your Transaction History
            </h3>
            <div style={{ textAlign: "center", padding: "32px 0", color: "#555" }}>
              <p>No transactions yet for this wallet.</p>
              <p style={{ fontSize: "0.85rem", marginTop: "8px" }}>Deposit USDC to start earning.</p>
            </div>
          </div>

          {/* Buy $PCP CTA */}
          <div style={{ textAlign: "center", padding: "20px", background: "rgba(138,43,226,0.06)", border: "1px solid rgba(138,43,226,0.2)", borderRadius: "12px" }}>
            <p style={{ color: "#888", marginBottom: "12px", fontSize: "0.9rem" }}>
              Acquire $PCP to participate in vault yield distribution
            </p>
            <a
              href="https://bags.fm/t/PCP"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#9b59b6", fontWeight: 700, textDecoration: "none", fontSize: "1rem" }}
            >
              🛍 Buy $PCP on Bags.fm →
            </a>
            &nbsp;&nbsp;·&nbsp;&nbsp;
            <a
              href={`https://jup.ag/swap/SOL-${PCP_MINT}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#888", fontWeight: 500, textDecoration: "none", fontSize: "0.9rem" }}
            >
              Jupiter →
            </a>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
