"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const CA = "4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS";
const LOGO = "/logo.jpg"; // served from public/ — zero latency on Vercel

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  const [tick,    setTick]    = useState(0);
  const [copied,  setCopied]  = useState(false);

  useEffect(() => {
    setMounted(true);
    const t = setInterval(() => setTick(n => n + 1), 2500);
    return () => clearInterval(t);
  }, []);

  if (!mounted) return null;

  const tickerItems = [
    "> 9-AGENT AI SWARM ONLINE",
    "> VELOCITY STREAM ACTIVE · &lt;2s LATENCY",
    "> OPTIMIZER CYCLE: 10min · GENETIC ALGO",
    "> TRAILING TP LIVE · LOCKS AT +2% PEAK",
    "> 28 RUGS BLACKLISTED · ZERO REPEATS",
    "> PUMPFUN SCANNER · KELLY-SIZED ENTRIES",
  ];

  const copyCA = () => {
    navigator.clipboard.writeText(CA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ background: "#000", minHeight: "100vh", overflowX: "hidden", color: "#fff", position: "relative" }}>

      {/* Scanline overlay */}
      <div style={{ position: "fixed", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.015) 2px, rgba(0,255,65,0.015) 4px)", pointerEvents: "none", zIndex: 9999 }} />

      {/* Glow orbs */}
      <div className="glow-orb glow-orb-primary" style={{ top: "-5%", left: "30%", width: "500px", height: "500px" }} />
      <div className="glow-orb glow-orb-secondary" style={{ bottom: "10%", right: "0", width: "600px", height: "600px" }} />

      {/* ── NAVBAR ─────────────────────────────────────────────────── */}
      <nav style={{
        padding: "16px 24px", display: "flex", justifyContent: "space-between",
        alignItems: "center", position: "sticky", top: 0, zIndex: 100,
        background: "rgba(0,0,0,0.92)", borderBottom: "1px solid rgba(0,255,65,0.15)",
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <img src={LOGO} alt="PCP" style={{ width: "36px", height: "36px", borderRadius: "8px", boxShadow: "0 0 12px rgba(0,255,65,0.4)" }} />
          <span className="font-terminal gradient-text" style={{ fontSize: "1.6rem", letterSpacing: "2px" }}>PCP</span>
        </div>
        <div className="hide-mobile" style={{ display: "flex", gap: "28px", fontFamily: "'Share Tech Mono', monospace", fontSize: "0.8rem", letterSpacing: "1px" }}>
          <a href="#strategy" style={{ color: "#666", textDecoration: "none", transition: "color 0.2s" }} onMouseOver={e => (e.currentTarget.style.color = "#00ff41")} onMouseOut={e => (e.currentTarget.style.color = "#666")}>/strategy</a>
          <a href="#agents"   style={{ color: "#666", textDecoration: "none", transition: "color 0.2s" }} onMouseOver={e => (e.currentTarget.style.color = "#00ff41")} onMouseOut={e => (e.currentTarget.style.color = "#666")}>/agents</a>
          <Link href="/monitor" style={{ color: "#00ff41", textDecoration: "none" }}>⚡ /live</Link>
        </div>
        <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" className="neon-btn" style={{
          background: "rgba(0,255,65,0.08)", border: "1px solid rgba(0,255,65,0.4)",
          color: "#00ff41", padding: "8px 18px", borderRadius: "6px", fontSize: "0.8rem",
          textDecoration: "none",
        }}>
          BUY $PCP
        </a>
      </nav>

      {/* ── HERO ───────────────────────────────────────────────────── */}
      <section style={{ padding: "80px 24px 60px", textAlign: "center", position: "relative", zIndex: 1 }}>

        {/* Live badge */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 16px", border: "1px solid rgba(0,255,65,0.4)", borderRadius: "4px", marginBottom: "32px", fontFamily: "'Share Tech Mono', monospace", fontSize: "0.78rem", letterSpacing: "2px", color: "#00ff41", background: "rgba(0,255,65,0.05)" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#00ff41", display: "inline-block", boxShadow: "0 0 6px #00ff41", animation: "greenPulse 1.5s ease infinite" }} />
          MAINNET LIVE · 9 AGENTS DEPLOYED
        </div>

        {/* Crow + headline */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0" }}>
          <img src={LOGO} alt="PCP Crow" style={{ width: "clamp(80px,15vw,130px)", marginBottom: "8px", filter: "drop-shadow(0 0 20px rgba(0,255,65,0.6))", animation: "greenPulse 4s ease infinite" }} />
          <h1 className="font-terminal" style={{ fontSize: "clamp(2.8rem, 8vw, 6.5rem)", letterSpacing: "4px", lineHeight: 1, color: "#00ff41", textShadow: "0 0 30px rgba(0,255,65,0.5), 0 0 60px rgba(0,255,65,0.2)", marginBottom: "8px" }}>
            &gt;POCKET CHANGE
          </h1>
          <h1 className="font-terminal" style={{ fontSize: "clamp(2.8rem, 8vw, 6.5rem)", letterSpacing: "4px", lineHeight: 1, color: "#fff", textShadow: "0 0 10px rgba(255,255,255,0.2)", marginBottom: "24px" }}>
            PROTOCOL<span className="cursor" />
          </h1>
        </div>

        <p className="font-mono" style={{ fontSize: "clamp(0.9rem, 2.5vw, 1.1rem)", color: "#888", maxWidth: "640px", margin: "0 auto 16px auto", lineHeight: 1.8, letterSpacing: "0.5px" }}>
          autonomous ai trading swarm · velocity-first momentum entry<br />
          reads on-chain swaps in <span style={{ color: "#00ff41" }}>&lt;2 seconds</span> · self-optimizes every 10 minutes
        </p>

        {/* Rotating ticker */}
        <div className="font-mono" style={{ display: "inline-block", padding: "10px 20px", border: "1px solid rgba(0,255,65,0.2)", borderRadius: "4px", background: "#000", color: "#00cc33", fontSize: "0.8rem", letterSpacing: "1px", marginBottom: "40px", minWidth: "340px" }}
          dangerouslySetInnerHTML={{ __html: tickerItems[tick % tickerItems.length] }} />

        {/* CTA buttons */}
        <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap", marginBottom: "60px" }}>
          <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" className="neon-btn" style={{
            background: "#00ff41", color: "#000", padding: "16px 40px",
            borderRadius: "4px", fontSize: "1rem", fontWeight: 900, border: "none",
            boxShadow: "0 0 24px rgba(0,255,65,0.5)", letterSpacing: "2px",
          }}>
            🛍 BUY $PCP
          </a>
          <Link href="/monitor" style={{
            background: "transparent", border: "1px solid rgba(0,255,65,0.4)",
            color: "#00ff41", padding: "16px 40px", borderRadius: "4px",
            textDecoration: "none", fontSize: "1rem", fontFamily: "'Share Tech Mono',monospace",
            letterSpacing: "2px", transition: "all 0.2s",
          }}
            onMouseOver={e => { e.currentTarget.style.background = "rgba(0,255,65,0.08)"; e.currentTarget.style.boxShadow = "0 0 16px rgba(0,255,65,0.2)"; }}
            onMouseOut={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.boxShadow = "none"; }}>
            ⚡ WATCH LIVE
          </Link>
        </div>

        {/* Stats bar */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", maxWidth: "600px", margin: "0 auto", border: "1px solid rgba(0,255,65,0.2)", borderRadius: "4px", overflow: "hidden" }} className="grid-mobile-3">
          {[
            { label: "AGENTS", value: "9" },
            { label: "SIGNAL LAG", value: "<2S" },
            { label: "OPT CYCLE", value: "10MIN" },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: "rgba(0,10,0,0.8)", padding: "20px 12px", textAlign: "center", borderRight: "1px solid rgba(0,255,65,0.1)" }}>
              <p className="font-mono" style={{ color: "#555", fontSize: "0.65rem", letterSpacing: "2px", marginBottom: "8px" }}>{label}</p>
              <p className="font-terminal" style={{ fontSize: "2.2rem", color: "#00ff41", textShadow: "0 0 12px rgba(0,255,65,0.5)" }}>{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Wave divider */}
      <div className="wave-graph" style={{ marginTop: "20px", opacity: 0.5 }} />

      {/* ── STRATEGY SECTION ──────────────────────────────────────── */}
      <section id="strategy" style={{ padding: "80px 24px", maxWidth: "1100px", margin: "0 auto", zIndex: 1, position: "relative" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "60px", alignItems: "center" }} className="stack-mobile" >
          <div>
            <p className="font-mono" style={{ color: "#00ff41", fontSize: "0.75rem", letterSpacing: "3px", marginBottom: "16px" }}>// ENTRY STRATEGY</p>
            <h2 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 900, lineHeight: 1.1, marginBottom: "20px" }}>
              In before the<br /><span style={{ color: "#00ff41", textShadow: "0 0 20px rgba(0,255,65,0.4)" }}>chart moves.</span>
            </h2>
            <p style={{ color: "#777", fontSize: "1rem", lineHeight: 1.8, marginBottom: "28px" }}>
              Most bots read DexScreener — a 30–60 second lagging API. PCP connects directly to Solana's raw transaction stream via Chainstack gRPC and detects buy acceleration the moment it hits the chain.
            </p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
              {[
                "gRPC WebSocket · raw on-chain swap detection",
                "isAccelerating flag · ≥60% buy ratio required",
                "cross-checked against 1h directional trend",
              ].map(t => (
                <li key={t} className="font-mono" style={{ display: "flex", alignItems: "flex-start", gap: "10px", color: "#aaa", fontSize: "0.85rem" }}>
                  <span style={{ color: "#00ff41", marginTop: "2px" }}>›</span> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="term-block" style={{ fontSize: "0.8rem", lineHeight: 2 }}>
            <p className="dim">// live engine output — solana mainnet</p>
            <p><span style={{ color: "#555" }}>[VELOCITY]</span> 🚀 ACCELERATING · 8B/2S · 0.032 SOL/60s</p>
            <p><span style={{ color: "#00ff41" }}>[SNIPER] </span> ⚡ VELOCITY ENTRY +67%/1h · 0.005 SOL</p>
            <p><span style={{ color: "#00ff41" }}>[SNIPER] </span> ✅ Entered · 2.9B tokens received</p>
            <p><span style={{ color: "#ffaa00" }}>[SNIPER] </span> 📊 PnL: +4.1% · 🎯 trail floor: +2.7%</p>
            <p><span style={{ color: "#00ff41" }}>[SNIPER] </span> 🔄 TRAIL EXIT · locked +3.9%</p>
            <p className="dim" style={{ fontSize: "0.72rem" }}>// tx confirmed · solscan.io/tx/5Cun...</p>
          </div>
        </div>
      </section>

      {/* ── AGENT GRID ─────────────────────────────────────────────── */}
      <section id="agents" style={{ padding: "80px 24px", maxWidth: "1100px", margin: "0 auto", position: "relative", zIndex: 1 }}>
        <p className="font-mono" style={{ color: "#00ff41", fontSize: "0.75rem", letterSpacing: "3px", marginBottom: "12px", textAlign: "center" }}>// THE SWARM</p>
        <h2 style={{ textAlign: "center", fontSize: "clamp(1.8rem,4vw,2.8rem)", fontWeight: 900, marginBottom: "8px" }}>9 Agents. One Objective.</h2>
        <p style={{ textAlign: "center", color: "#666", marginBottom: "48px", fontFamily: "'Share Tech Mono',monospace", fontSize: "0.85rem" }}>each agent owns one piece of the stack · together they never sleep</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }} className="grid-mobile-2">
          {[
            { e: "⚡", t: "Velocity Entry",         d: "gRPC stream · <2s detection · fires before DexScreener shows anything",                  c: "#00ff41" },
            { e: "🧠", t: "Swarm Optimizer",        d: "6-agent genetic loop · Gemini LLM critique · promotes params every 10min",               c: "#aa55ff" },
            { e: "🎯", t: "Tiered Trailing TP",     d: "Activates at +2% peak · tightens as gains grow · 85% retention at +20%",                 c: "#ffaa00" },
            { e: "🛡️", t: "Rug Detection",          d: "8 checks: honeypot, bundler wallets, freeze authority · permanent blacklist",             c: "#ff4444" },
            { e: "🚀", t: "PumpFun Scanner",         d: "Launchpad monitoring · Kelly-fractioned sizing · EMA win-rate adaptive",                  c: "#3b82f6" },
            { e: "↩️", t: "Order Flow Reversal",    d: "Watches buy/sell ratio post-entry · exits at -2% if sellers take over in <3min",          c: "#ec4899" },
          ].map(({ e, t, d, c }) => (
            <div key={t}
              style={{ background: "rgba(0,5,0,0.8)", border: `1px solid ${c}22`, borderRadius: "6px", padding: "24px 20px", transition: "border-color 0.3s, transform 0.3s", cursor: "default" }}
              onMouseOver={ev => { ev.currentTarget.style.borderColor = `${c}66`; ev.currentTarget.style.transform = "translateY(-4px)"; }}
              onMouseOut={ev => { ev.currentTarget.style.borderColor = `${c}22`; ev.currentTarget.style.transform = "translateY(0)"; }}>
              <div style={{ fontSize: "1.8rem", marginBottom: "12px" }}>{e}</div>
              <h3 className="font-mono" style={{ fontSize: "0.9rem", fontWeight: 700, color: c, letterSpacing: "1px", marginBottom: "8px", textTransform: "uppercase" }}>{t}</h3>
              <p style={{ color: "#666", fontSize: "0.82rem", lineHeight: 1.7 }}>{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CA + CTA ───────────────────────────────────────────────── */}
      <section style={{ padding: "80px 24px", maxWidth: "800px", margin: "0 auto", textAlign: "center", position: "relative", zIndex: 1 }}>
        <div className="glow-orb glow-orb-primary" style={{ top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "500px", height: "300px", opacity: 0.08 }} />

        <p className="font-mono" style={{ color: "#00ff41", fontSize: "0.75rem", letterSpacing: "3px", marginBottom: "16px" }}>// JOIN THE SWARM</p>
        <h2 className="font-terminal" style={{ fontSize: "clamp(2.5rem,6vw,4.5rem)", color: "#00ff41", textShadow: "0 0 30px rgba(0,255,65,0.4)", letterSpacing: "3px", marginBottom: "12px" }}>
          &gt; EARLY IS EVERYTHING.
        </h2>
        <p style={{ color: "#666", marginBottom: "36px", fontFamily: "'Share Tech Mono',monospace", fontSize: "0.9rem" }}>
          the optimizer is learning · the swarm is live · the edge is compounding
        </p>

        {/* CA copyable */}
        <button onClick={copyCA} style={{
          display: "inline-flex", alignItems: "center", gap: "10px", padding: "12px 20px",
          background: "rgba(0,10,0,0.9)", border: "1px solid rgba(0,255,65,0.3)", borderRadius: "6px",
          fontFamily: "'Share Tech Mono',monospace", fontSize: "clamp(0.65rem,1.8vw,0.8rem)",
          color: copied ? "#00ff41" : "#aaa", cursor: "pointer", marginBottom: "36px",
          maxWidth: "100%", overflowX: "hidden", transition: "all 0.2s", wordBreak: "break-all",
        }}>
          <span style={{ color: "#444", flexShrink: 0 }}>CA:</span>
          <span style={{ color: "#fff" }}>{CA}</span>
          <span style={{ color: "#00ff41", flexShrink: 0 }}>{copied ? "✓ COPIED" : "[ COPY ]"}</span>
        </button>

        <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" }}>
          <a href="https://bags.fm/t/PCP" target="_blank" rel="noopener noreferrer" className="neon-btn" style={{
            background: "#00ff41", color: "#000", padding: "16px 44px", borderRadius: "4px",
            fontSize: "1rem", fontWeight: 900, border: "none", letterSpacing: "2px",
            boxShadow: "0 0 24px rgba(0,255,65,0.5)",
          }}>
            🛍 BUY $PCP
          </a>
          <Link href="/monitor" style={{
            border: "1px solid rgba(0,255,65,0.3)", color: "#00ff41", padding: "16px 36px",
            borderRadius: "4px", textDecoration: "none", fontFamily: "'Share Tech Mono',monospace",
            fontSize: "0.9rem", letterSpacing: "2px",
          }}>
            ⚡ LIVE ENGINE
          </Link>
        </div>
      </section>

      {/* Wave bottom */}
      <div className="wave-graph" style={{ transform: "scaleY(-1)", opacity: 0.4 }} />

      {/* ── FOOTER ─────────────────────────────────────────────────── */}
      <footer style={{ padding: "32px 24px", borderTop: "1px solid rgba(0,255,65,0.1)", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <img src={LOGO} alt="PCP" style={{ width: "24px", height: "24px", borderRadius: "4px", opacity: 0.7 }} />
          <span className="font-terminal" style={{ color: "#00ff41", fontSize: "1.1rem", letterSpacing: "2px" }}>POCKET CHANGE PROTOCOL</span>
        </div>
        <p className="font-mono" style={{ color: "#333", fontSize: "0.75rem", letterSpacing: "1px" }}>
          autonomous ai swarm on solana ·{" "}
          <a href="https://twitter.com/PocketChangePCP" target="_blank" rel="noopener noreferrer" style={{ color: "#00ff41", textDecoration: "none" }}>@PocketChangePCP</a>
          {" "}· not financial advice · #NFA
        </p>
      </footer>
    </div>
  );
}
