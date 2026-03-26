"use client";

import { Save, VpnKey, Security, SupportAgent, Key, Webhook, NotificationsActive, LockRounded, BuildCircle, ErrorOutline } from "@mui/icons-material";
import { useState } from "react";

export default function SettingsPage() {
  const [selectedTab, setSelectedTab] = useState("api");

  const tabs = [
    { id: "api", label: "API & Webhooks", icon: <Webhook /> },
    { id: "security", label: "Account Security", icon: <LockRounded /> },
    { id: "engine", label: "Execution Engine", icon: <BuildCircle /> },
    { id: "notifications", label: "Alerts & Notifications", icon: <NotificationsActive /> }
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", animation: "fadeIn 0.5s ease" }}>
      <header>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "8px" }}>Tenant Settings & Configuration</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>Securely manage your KMS encryption master keys, account access, and webhooks.</p>
      </header>

      <div className="settings-layout" style={{ display: "flex", gap: "32px" }}>

        {/* Navigation Sidebar */}
        <aside className="settings-nav" style={{ width: "250px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {tabs.map(tab => (
            <button key={tab.id}
              onClick={() => setSelectedTab(tab.id)}
              style={{
                display: "flex", alignItems: "center", gap: "12px", padding: "16px",
                border: "none", background: selectedTab === tab.id ? "rgba(138,43,226,0.15)" : "transparent",
                color: selectedTab === tab.id ? "var(--primary)" : "var(--text-secondary)",
                borderRadius: "12px", cursor: "pointer", fontWeight: selectedTab === tab.id ? 600 : 500,
                textAlign: "left", transition: "all 0.2s ease",
                borderLeft: selectedTab === tab.id ? "4px solid var(--primary)" : "4px solid transparent"
              }}>
               {tab.icon} {tab.label}
            </button>
          ))}
        </aside>

        {/* Content Area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "24px" }}>
           
           {/* General API Configuration Box */}
           {selectedTab === "api" && (
             <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px" }}>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
                    <Key style={{ color: "var(--secondary)" }} /> API Access Tokens
                </h2>
                <div style={{ padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)", marginBottom: "24px" }}>
                   <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "8px" }}>REST / GraphQL Master Bearer Token</p>
                   <div style={{ display: "flex", gap: "12px" }}>
                       <input type="password" value="sk_test_arbitrasaas_x9F82nA1" readOnly style={{ flex: 1, padding: "12px", background: "rgba(255,255,255,0.05)", color: "#fff", border: "none", borderRadius: "6px", fontFamily: "monospace", letterSpacing: "2px", outline: "none" }} />
                       <button style={{ padding: "0 24px", background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", borderRadius: "6px", cursor: "pointer" }}>Copy</button>
                       <button style={{ padding: "0 24px", background: "transparent", border: "1px solid var(--error)", color: "var(--error)", borderRadius: "6px", cursor: "pointer" }}>Rotate</button>
                   </div>
                </div>

                <h2 style={{ fontSize: "1.3rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px", marginTop: "40px" }}>
                    <Webhook style={{ color: "var(--success)" }} /> Event Webhooks
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", marginBottom: "16px", lineHeight: 1.6 }}>Listen to real-time events on your private server when a profitable arbitrage bundle executes and lands on-chain.</p>
                <div style={{ display: "flex", gap: "12px", marginBottom: "32px" }}>
                     <input type="text" placeholder="https://your-server.com/webhooks/arbitrasaas" style={{ flex: 1, padding: "12px", background: "rgba(255,255,255,0.05)", color: "#fff", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", letterSpacing: "1px", outline: "none" }} />
                     <button style={{ padding: "0 24px", background: "var(--primary)", border: "none", color: "#fff", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>Save Webhook URL</button>
                </div>
             </section>
           )}

           {selectedTab === "security" && (
             <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px" }}>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
                    <Security style={{ color: "var(--success)" }} /> Hardware Security Module (KMS)
                </h2>
                
                <div style={{ display: "flex", alignItems: "flex-start", gap: "16px", background: "rgba(255,0,0,0.05)", border: "1px solid var(--error)", padding: "16px", borderRadius: "12px", marginBottom: "32px" }}>
                     <ErrorOutline style={{ color: "var(--error)", marginTop: "4px" }} />
                     <div>
                         <h4 style={{ color: "var(--error)", marginBottom: "8px" }}>Master Decryption Matrix Override</h4>
                         <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", lineHeight: 1.5 }}>
                            Your fleet wallets are exclusively protected by AES-256-GCM. Modifying or losing your external KMS wrapper string means the system will instantly lose the ability to deploy executing payloads. We cannot recover KMS hashes.
                         </p>
                     </div>
                </div>
                
                <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "16px" }}>Two-Factor Authentication (2FA)</h3>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", background: "rgba(0,0,0,0.2)", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                    <div>
                        <p style={{ fontWeight: 600, color: "#fff", marginBottom: "6px" }}>Authenticator App</p>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>Required for high-value wallet extractions and deletion events.</p>
                    </div>
                    <button style={{ background: "transparent", color: "var(--success)", border: "1px solid var(--success)", padding: "8px 16px", borderRadius: "6px", cursor: "pointer" }}>Enabled</button>
                </div>
             </section>
           )}

           {selectedTab === "engine" && (
             <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px" }}>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
                    <BuildCircle style={{ color: "var(--primary)" }} /> Global Execution Limits
                </h2>
                
                <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                    <div>
                        <label style={{ color: "var(--text-secondary)", fontSize: "0.85rem", display: "block", marginBottom: "8px" }}>Maximum Simultaneous NATS Ticks (Per Second)</label>
                        <select style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", padding: "12px", borderRadius: "6px", outline: "none" }}>
                            <option>100 Ticks / Second (PRO Default)</option>
                            <option>500 Ticks / Second (Enterprise Limit)</option>
                            <option>Unlimited (Requires Manual Cluster Review)</option>
                        </select>
                    </div>

                    <div>
                        <label style={{ color: "var(--text-secondary)", fontSize: "0.85rem", display: "block", marginBottom: "8px" }}>Failsafe Hard-Stop Loss Limit (Rolling 24h)</label>
                        <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px" }}>
                            <span style={{ padding: "12px 16px", color: "var(--text-secondary)", borderRight: "1px solid rgba(255,255,255,0.1)" }}>SOL</span>
                            <input type="number" defaultValue={250} style={{ flex: 1, padding: "12px", background: "transparent", color: "#fff", border: "none", outline: "none", fontWeight: 600 }} />
                        </div>
                    </div>

                    <button style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", background: "linear-gradient(135deg, var(--primary), var(--secondary))", color: "#fff", border: "none", padding: "14px", borderRadius: "8px", fontWeight: 700, cursor: "pointer", marginTop: "16px" }}>
                        <Save /> Save Engine Configurations
                    </button>
                </div>
             </section>
           )}
           
           {selectedTab === "notifications" && (
             <section className="glassmorphism fade-in" style={{ padding: "32px", borderRadius: "16px" }}>
                 <p style={{ color: "var(--text-secondary)" }}>Link your Telegram ID or Discord Webhook to receive instant execution pings. Support team integration is active.</p>
             </section>
           )}

        </div>
      </div>
    </div>
  );
}
