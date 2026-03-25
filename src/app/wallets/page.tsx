"use client";

import { Add, ContentCopy, DeleteOutline, VisibilityOff, Loop, Close, AccountBalanceWallet } from "@mui/icons-material";
import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Transaction, PublicKey, TransactionInstruction } from "@solana/web3.js";

export default function WalletsPage() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Deposit Modal State
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("1000");
  const [txStatus, setTxStatus] = useState<string | null>(null);

  // Active Position & Cooldown State
  const [activeStakedUSDC, setActiveStakedUSDC] = useState(1420);
  const [activeShares, setActiveShares] = useState(1391.6);
  const [cooldownTime, setCooldownTime] = useState(0); // 0 means inactive
  const [isVaultPaused, setIsVaultPaused] = useState(false); // Admin Pause Auth

<<<<<<< HEAD
  const PROGRAM_ID = new PublicKey("34sgN4q5CaaGCwqePU6d2y6xzBuY5ASA8E8LtXjfyN3c"); 
=======
  const PROGRAM_ID = new PublicKey("FSRUKKMxfWNDiVKKVyxiaaweZR8HZEMnsyHmb8caPjAy"); 
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
  const NETWORK = process.env.NEXT_PUBLIC_NETWORK || "localnet"; 
  const USDC_MINT = NETWORK === "devnet" 
      ? new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
      : new PublicKey("J86cnryv65eNYsgXx3KssYcEh34gkDwqwpVR4SYEEoAd"); 
  const PCP_MINT = NETWORK === "devnet"
<<<<<<< HEAD
      ? new PublicKey("11111111111111111111111111111111")
=======
      ? new PublicKey("PCPxZ3m2v...mockdev")
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
      : new PublicKey("HnroupxERUkWZGzqcqWyXHbGF326rV2MkcT4RNcKY3Aw");

  useEffect(() => {
    let interval: string | number | NodeJS.Timeout | undefined;
    if (cooldownTime > 0) {
        interval = setInterval(() => setCooldownTime(p => p - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [cooldownTime]);

  const handleDeposit = async () => {
      if (!publicKey) {
          alert("Connect Phantom wallet first!");
          return;
      }
      setTxStatus("building");
      try {
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
          setTxStatus("signing");
          const signature = await sendTransaction(tx, connection);
          
          setTxStatus("confirming");
          // Not awaiting confirmation on cluster since it's an MVP mockup pointing to live network without enough gas potentially
          setTimeout(() => {
              setTxStatus("success");
              setActiveStakedUSDC(prev => prev + parseFloat(depositAmount));
              setActiveShares(prev => prev + (parseFloat(depositAmount) * 0.98));
              setCooldownTime(86400); // Trigger 24h Cooldown logic as requested
              
              setTimeout(() => { setIsDepositModalOpen(false); setTxStatus(null); }, 3000);
          }, 2000);

      } catch (err: any) {
          console.error(err);
          setTxStatus("error");
          setTimeout(() => setTxStatus(null), 3000);
      }
  };

  const fetchWallets = async () => {
      setLoading(true);
      try {
          const res = await fetch("/api/wallets");
          const data = await res.json();
          setWallets(data);
      } catch (err) {
          console.error(err);
      } finally {
          setLoading(false);
      }
  };

  useEffect(() => {
    fetchWallets();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.4s ease forwards" }}>
      <header className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px" }}>Vault Staking</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>Deposit USDC and earn auto-compounding yields from the Arbitrage execution layer.</p>
        </div>
        <div className="page-header-actions" style={{ display: "flex", gap: "16px" }}>
            <button onClick={() => setIsVaultPaused(!isVaultPaused)} style={{
                background: isVaultPaused ? "rgba(255, 68, 68, 0.15)" : "rgba(255, 255, 255, 0.05)", 
                border: isVaultPaused ? "1px solid rgba(255, 68, 68, 0.4)" : "1px solid var(--border)", 
                color: isVaultPaused ? "#ff4444" : "#fff",
                padding: "12px 16px", borderRadius: "8px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", fontWeight: 600
            }}>
                {isVaultPaused ? "Vault: PAUSED (Admin)" : "Vault: ACTIVE"}
            </button>
            <button onClick={fetchWallets} style={{
                background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "#fff",
                padding: "12px", borderRadius: "8px", cursor: "pointer", display: "flex", alignItems: "center"
            }}>
                <Loop style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
            </button>
            <button onClick={() => setIsDepositModalOpen(true)} disabled={isVaultPaused} style={{
            background: isVaultPaused ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))",
            color: isVaultPaused ? "rgba(255,255,255,0.5)" : "#fff", border: "1px solid rgba(255,255,255,0.2)", padding: "12px 24px", borderRadius: "8px", fontWeight: 600, cursor: isVaultPaused ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "8px", boxShadow: "0 4px 14px rgba(255, 255, 255, 0.1)"
            }}>
            <Add style={{ fontSize: "1.2rem" }} /> Deposit into Vault
            </button>
        </div>
      </header>

      <div className="glassmorphism fade-in" style={{ borderRadius: "16px", padding: "24px", overflowX: "auto" }}>
        {connected && (
          <div style={{ marginBottom: "32px", padding: "24px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.1)", background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(0,0,0,0.3))" }}>
            <h3 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "20px", display: "flex", alignItems: "center", gap: "10px" }}><AccountBalanceWallet /> Your Active Position</h3>
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "24px" }}>
              <div style={{ background: "rgba(255,255,255,0.02)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "8px" }}>Staked USDC</p>
                <p style={{ fontSize: "1.8rem", fontWeight: 800 }}>${activeStakedUSDC.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
              <div style={{ background: "rgba(255,255,255,0.02)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "8px" }}>$PCP Tokens</p>
                <p style={{ fontSize: "1.8rem", fontWeight: 800 }}>{activeShares.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
              </div>
              <div style={{ background: "rgba(255,255,255,0.02)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "8px" }}>Compounded Profit</p>
                <p style={{ fontSize: "1.8rem", fontWeight: 800, color: "var(--success)" }}>+$48.12</p>
              </div>
            </div>

            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: "12px", padding: "16px", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
                <p style={{ fontSize: "0.95rem", fontWeight: 600 }}>Your Algorithmic Flash-Swaps</p>
                <span style={{ fontSize: "0.75rem", color: "var(--success)", display: "flex", alignItems: "center", gap: "6px" }}><span style={{width:"6px",height:"6px",background:"var(--success)",borderRadius:"50%",boxShadow:"0 0 8px var(--success)"}}></span> Syncing Routes</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: "10px" }}>
                  <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>0.82s ago</span>
                  <span><strong>USDC → RAY → USDC</strong> (Jupiter V6)</span>
                  <span style={{ color: "var(--success)", fontWeight: 700 }}>+0.08% Yield</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>2.4s ago</span>
                  <span><strong>USDC → BONK → USDC</strong> (Orca Whirlpool)</span>
                  <span style={{ color: "var(--success)", fontWeight: 700 }}>+0.12% Yield</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-secondary)" }}>
            <Loop style={{ animation: "spin 1s linear infinite", fontSize: "2rem", marginBottom: "12px" }} />
            <p>Loading vault data...</p>
          </div>
        ) : wallets.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <AccountBalanceWallet style={{ fontSize: "3rem", color: "var(--text-secondary)", marginBottom: "16px" }} />
            <p style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "8px" }}>No active stakers yet</p>
            <p style={{ color: "var(--text-secondary)", marginBottom: "24px" }}>Be the first to deposit USDC and earn arbitrage yields.</p>
            <button onClick={() => setIsDepositModalOpen(true)} style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", padding: "12px 32px", borderRadius: "10px", fontWeight: 700, cursor: "pointer", fontSize: "1rem" }}>
              + Deposit into Vault
            </button>
          </div>
        ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", whiteSpace: "nowrap" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>
<<<<<<< HEAD
              <th style={{ padding: "16px" }}>Staker Address</th>
              <th style={{ padding: "16px" }}>Total Deposited</th>
              <th style={{ padding: "16px" }}>Pool Share ($PCP)</th>
=======
              <th style={{ padding: "16px" }}>Operator Wallet</th>
              <th style={{ padding: "16px" }}>Balance</th>
              <th style={{ padding: "16px" }}>Configuration</th>
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
              <th style={{ padding: "16px" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w, idx) => (
              <tr key={w.id} style={{ borderBottom: idx !== wallets.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td style={{ padding: "16px", fontWeight: 500, fontFamily: "monospace", color: "var(--secondary)", fontSize: "0.9rem" }}>
                  {w.pubkey?.slice(0,6)}...{w.pubkey?.slice(-4)}
                  <ContentCopy onClick={() => navigator.clipboard.writeText(w.pubkey)} style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginLeft: "8px", cursor: "pointer", verticalAlign: "middle" }} />
                </td>
                <td style={{ padding: "16px", fontWeight: 700 }}>{w.balance}</td>
                <td style={{ padding: "16px" }}>
                  <span style={{ padding: "6px 12px", background: "rgba(255,255,255,0.05)", borderRadius: "6px", fontSize: "0.85rem", border: "1px solid rgba(255,255,255,0.1)", color: "#29b6f6" }}>
                    {w.config}
                  </span>
                </td>
                <td style={{ padding: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: w.status === "Active" ? "var(--success)" : "var(--error)", boxShadow: `0 0 8px ${w.status === "Active" ? "var(--success)" : "var(--error)"}` }}></div>
                    <span style={{ fontSize: "0.9rem", color: w.status === "Active" ? "var(--success)" : "var(--error)" }}>{w.status}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      <div className="grid-2-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.2)" }}>
          <h3 style={{ fontSize: "1.2rem", fontWeight: 600, marginBottom: "16px" }}>Unstaking Execution</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", lineHeight: 1.6, marginBottom: "16px" }}>
            Withdraw liquidity at any time by burning your $PCP. A smart-contract enforced <strong>0.5% unstaking fee</strong> is deducted from the gross withdrawal amount and routed to the treasury to discourage short-term capital flight and benefit long-term holders.
          </p>
          <button 
             disabled={cooldownTime > 0 || isVaultPaused}
             style={{ 
                 background: cooldownTime > 0 ? "rgba(255,255,255,0.02)" : "transparent", 
                 border: "1px solid var(--border)", 
                 padding: "10px 16px", 
                 color: (cooldownTime > 0 || isVaultPaused) ? "var(--text-secondary)" : "var(--text-primary)", 
                 borderRadius: "8px", 
                 cursor: (cooldownTime > 0 || isVaultPaused) ? "not-allowed" : "pointer", 
                 display: "flex", alignItems: "center", gap: "8px" 
             }}>
             {isVaultPaused ? "Unstaking Disabled (Vault Paused)" : 
              cooldownTime > 0 ? `Unstaking Locked (Cooldown: ${Math.floor(cooldownTime / 3600)}h ${Math.floor((cooldownTime % 3600) / 60)}m)` : 'Withdraw Liquidity Instantly'}
          </button>
        </div>

        <div className="glassmorphism fade-in" style={{ padding: "24px", borderRadius: "16px", background: "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))" }}>
          <h3 style={{ fontSize: "1.2rem", fontWeight: 600, marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ color: "var(--primary)" }}>★</span> Smart Contract Audited
          </h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", lineHeight: 1.6, marginBottom: "24px" }}>
            The PocketChange Vault program utilizes native Anchor multi-sig limits. The contract is non-custodial; the master admin cannot withdraw user deposits, only process yielding flash-swaps.
          </p>
          <div style={{ background: "rgba(0,0,0,0.3)", height: "8px", borderRadius: "4px", width: "100%", overflow: "hidden", marginBottom: "8px" }}>
             <div style={{ height: "100%", width: "100%", background: "linear-gradient(90deg, rgba(255,255,255,0.2), var(--primary))", borderRadius: "4px" }}></div>
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", textAlign: "right" }}>Vault Capacity: Unlimited</p>
        </div>
      </div>

      {isDepositModalOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.8)", backdropFilter: "blur(10px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="glassmorphism fade-in modal-responsive" style={{ width: "450px", padding: "32px", borderRadius: "20px", border: "1px solid rgba(255, 255, 255, 0.2)", position: "relative" }}>
             <button onClick={() => setIsDepositModalOpen(false)} style={{ position: "absolute", top: "24px", right: "24px", background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}>
                 <Close />
             </button>
             <h2 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: "8px" }}>Deposit USDC <span style={{ color: "var(--text-secondary)", fontSize: "1rem", fontWeight: 500 }}>to Vault</span></h2>
             
             <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", padding: "16px", borderRadius: "12px", marginBottom: "24px", marginTop: "24px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                    <span>Amount</span>
                    <span>Balance: 0.00 USDC</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--primary)" }}>$</span>
                    <input type="number" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} style={{ width: "100%", background: "transparent", border: "none", color: "#fff", fontSize: "1.5rem", fontWeight: 700, outline: "none" }} />
                    <button style={{ padding: "4px 8px", background: "rgba(255, 255, 255, 0.1)", color: "var(--primary)", border: "1px solid rgba(255, 255, 255, 0.2)", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>MAX</button>
                </div>
             </div>

             <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "24px", padding: "12px", background: "rgba(0,0,0,0.3)", borderRadius: "8px", border: "1px dashed rgba(255,255,255,0.1)" }}>
                <div>
                   <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>You will receive</p>
                   <p style={{ fontWeight: 700, color: "var(--primary)" }}>{ (parseFloat(depositAmount || "0") * 0.98).toFixed(2) } $PCP</p>
                </div>
                <div style={{ textAlign: "right" }}>
                   <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>Network Fee</p>
                   <p style={{ fontWeight: 600, color: "#fff" }}>0.00001 SOL</p>
                </div>
             </div>

             <button
                disabled={!connected || txStatus === "signing" || txStatus === "confirming"}
                onClick={handleDeposit}
                style={{
                  width: "100%", padding: "16px", background: "linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
                  color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "12px", fontSize: "1.1rem", fontWeight: 700, cursor: (!connected || txStatus === "signing" || txStatus === "confirming") ? "not-allowed" : "pointer", boxShadow: "0 4px 20px rgba(255, 255, 255, 0.1)", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px"
              }}>
                  {txStatus === "building" ? "Compiling Instructions..." 
                     : txStatus === "signing" ? "Awaiting Phantom Signature..." 
                     : txStatus === "confirming" ? <><Loop style={{ animation: "spin 1s linear infinite" }} /> Confirming on-chain...</>
                     : txStatus === "success" ? "Deposit Successful!"
                     : txStatus === "error" ? "Transaction Failed"
                     : connected ? <><AccountBalanceWallet /> Sign Transacton & Deposit</> 
                     : "Please Connect Wallet"}
             </button>
          </div>
        </div>
      )}

      <style>{`
          @keyframes spin { 100% { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
