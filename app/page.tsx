const overviewStats = [
  { label: "Ticker", value: "$PCP" },
  { label: "Chain", value: "Solana SPL" },
  { label: "Supply", value: "1B" },
  { label: "Vault Split", value: "80 / 20" },
];

const strategies = [
  {
    name: "Triangular Arbitrage",
    description: "Exploit price gaps between SOL, USDC, and USDT pairs across Solana venues.",
    target: "0.1–0.5% per trade",
  },
  {
    name: "CEX–DEX Arbitrage",
    description: "Route capital between centralized exchanges and on-chain liquidity for spread capture.",
    target: "0.5–2% per cycle",
  },
  {
    name: "Flash Loan Arbitrage",
    description: "Use atomic capital to close transient inefficiencies without locking user funds.",
    target: "Variable",
  },
  {
    name: "Prediction Market Arb",
    description: "Capture complete-set dislocations and event-driven price mismatches.",
    target: "Event-driven",
  },
];

const tokenomics = [
  ["Liquidity Pool (SOL/$PCP)", "30%", "Locked 12 months"],
  ["Vault Staking Rewards", "20%", "Emitted over 3 years"],
  ["Team", "15%", "1-year cliff, 2-year linear"],
  ["Treasury", "15%", "Multi-sig controlled"],
  ["Community Airdrops", "10%", "Immediate"],
  ["Strategic Partners", "10%", "6-month cliff"],
];

const readinessRows = [
  ["Public Health", "/api/health", "Site and backend readiness signal"],
  ["Arb Windows", "/api/arb-windows", "Backend opportunity proxy when enabled"],
  ["Alpha Signals", "/api/alpha-signals", "Signal feed proxy for dashboards and tooling"],
  ["Token Scan", "/api/token-scan", "Scanner surface for discovery workflows"],
  ["Code Audit", "/api/code-audit", "Audit endpoint for external review tooling"],
];

const roadmap = [
  ["Q2 2026", "Token foundation, Raydium liquidity, vault contract work, and community launch."],
  ["Q3 2026", "Mainnet vault launch, initial arbitrage strategies, and first profit distribution."],
  ["Q4 2026", "Flash loans, prediction market arb, negative-rate monitoring, and exchange expansion."],
  ["2027", "DAO governance, cross-chain expansion, and institutional integrations."],
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero hero-grid">
        <div>
          <span className="eyebrow">PocketChange on Solana</span>
          <h1>Turning pocket change into institutional-grade arbitrage exposure.</h1>
          <p>
            PocketChange Protocol is the decentralized arbitrage protocol behind{" "}
            <span className="code">$PCP</span>. Users deposit SOL or USDC into the
            PocketChange Vault, receive liquid pool-share exposure, and participate in
            automated arbitrage across Solana DEXs, external venues, and event-driven
            dislocations.
          </p>
          <div className="actions">
            <a className="button primary" href="/api/health">
              View Live Health
            </a>
            <a className="button secondary" href="/api/arb-windows?capitalSol=1&minBps=3">
              Inspect Arb Windows
            </a>
          </div>
        </div>

        <aside className="hero-panel card">
          <p className="micro-label">Token Overview</p>
          <div className="stat-strip">
            {overviewStats.map((stat) => (
              <div className="mini-stat" key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
          <div className="hero-meta">
            <div>
              <span className="micro-label">Contract</span>
              <p className="code wrap">4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS</p>
            </div>
            <div>
              <span className="micro-label">Liquidity</span>
              <p>Locked for 12 months, with treasury and governance parameters exposed on-chain.</p>
            </div>
          </div>
        </aside>
      </section>

      <section className="grid">
        <article className="card">
          <p className="micro-label">The Problem</p>
          <h2 className="section-title">Arbitrage is reliable, but it is still gated behind speed, capital, and infrastructure.</h2>
          <p className="muted">
            PocketChange exists to make high-frequency arbitrage participation accessible
            without asking every holder to build bots, colocate servers, or fight MEV
            infrastructure alone.
          </p>
          <ul className="list">
            <li>Retail capital is usually too small to capture thin but repeatable spreads.</li>
            <li>Latency, routing complexity, and operational overhead favor institutional players.</li>
            <li>MEV and sandwich attacks punish public, unsheltered execution.</li>
          </ul>
        </article>

        <article className="card">
          <p className="micro-label">The Solution</p>
          <h2 className="section-title">A community-owned vault with compounding exposure to arbitrage profits.</h2>
          <p className="muted">
            PocketChange routes pooled capital into automated strategies, compounds 80% of
            realized gains back into the vault, and directs 20% to the treasury for protocol
            growth, safety, and governance.
          </p>
          <ul className="list">
            <li>Deposits mint liquid pool-share exposure via $PCP.</li>
            <li>Execution uses private routing, Jito-aware protection, and atomic transaction design.</li>
            <li>Withdrawals burn $PCP and apply a 0.5% unstaking fee to protect the pool.</li>
          </ul>
        </article>
      </section>

      <section className="card">
        <p className="micro-label">Core Strategies</p>
        <div className="feature-grid">
          {strategies.map((strategy) => (
            <article className="feature-card" key={strategy.name}>
              <h3>{strategy.name}</h3>
              <p className="muted">{strategy.description}</p>
              <span className="target-pill">{strategy.target}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <p className="micro-label">Vault Economics</p>
          <h2 className="section-title">Tokenomics that reward long-term participation.</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Allocation</th>
                  <th>Share</th>
                  <th>Terms</th>
                </tr>
              </thead>
              <tbody>
                {tokenomics.map(([name, share, terms]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{share}</td>
                    <td>{terms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="list tight">
            <li>Mint authority renounced.</li>
            <li>Freeze authority renounced.</li>
            <li>LP tokens locked via Streamflow.</li>
          </ul>
        </article>

        <article className="card">
          <p className="micro-label">Architecture</p>
          <h2 className="section-title">Deposit, execute, compound, report.</h2>
          <ol className="architecture">
            <li>User deposits USDC or SOL into the PocketChange Vault.</li>
            <li>The vault mints $PCP as the liquid pool-share token.</li>
            <li>Off-chain execution bots score and route arbitrage opportunities.</li>
            <li>Profits remain mostly in the vault, increasing underlying token value.</li>
            <li>Treasury capture funds audits, growth, and insurance-oriented safeguards.</li>
          </ol>
        </article>
      </section>

      <section className="grid">
        <article className="card">
          <p className="micro-label">Public Readiness Surface</p>
          <h2 className="section-title">pcprotocol.dev now exposes the operational surfaces the protocol needs for demo and monitoring.</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Path</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {readinessRows.map(([name, path, purpose]) => (
                  <tr key={path}>
                    <td>{name}</td>
                    <td className="code">{path}</td>
                    <td>{purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            The frontend never embeds trading secrets or wallet material. Backend proxying is
            controlled by server-side environment configuration only.
          </p>
        </article>

        <article className="card">
          <p className="micro-label">Roadmap</p>
          <h2 className="section-title">From vault launch to governed, cross-chain expansion.</h2>
          <ul className="list">
            {roadmap.map(([phase, detail]) => (
              <li key={phase}>
                <strong>{phase}:</strong> {detail}
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card">
        <p className="micro-label">Transparency</p>
        <h2 className="section-title">Open code, visible profits, and community-readable operations.</h2>
        <div className="feature-grid compact">
          <article className="feature-card">
            <h3>Open Source</h3>
            <p className="muted">Code, monitoring, and deployment surfaces are versioned in GitHub.</p>
          </article>
          <article className="feature-card">
            <h3>Real-Time Dashboard</h3>
            <p className="muted">Health, arb, and signal surfaces are designed for public monitoring and operator review.</p>
          </article>
          <article className="feature-card">
            <h3>Community Treasury</h3>
            <p className="muted">Treasury capture and future governance are part of the protocol’s operating model.</p>
          </article>
        </div>
      </section>

      <p className="footer">
        PocketChange Protocol on Solana. This site is the public readiness surface for{" "}
        <span className="code">pcprotocol.dev</span>, with backend proxying controlled by{" "}
        <span className="code">PCP_API_BASE_URL</span>. Nothing on this page is financial advice.
      </p>
    </main>
  );
}
