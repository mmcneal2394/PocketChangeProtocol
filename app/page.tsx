const statusCards = [
  {
    title: "Live Stack",
    body: "Slopfest sniper, wallet intel, guardian, profit accumulator, allocator, and arb scout are now represented in one deployable demo surface.",
  },
  {
    title: "Deploy Model",
    body: "The arb side is scout and live-eligibility aware. It is not advertised here as a production-safe live arbitrage executor.",
  },
  {
    title: "Vercel Alignment",
    body: "This root app exists so the Vercel project behind pcprotocol.dev has a coherent Next.js site and health endpoint to deploy.",
  },
];

const serviceRows = [
  {
    name: "Health",
    path: "/api/health",
    note: "Local site health plus optional backend probe.",
  },
  {
    name: "Arb Windows",
    path: "/api/arb-windows",
    note: "Safe proxy to backend when PCP_API_BASE_URL is configured.",
  },
  {
    name: "Alpha Signals",
    path: "/api/alpha-signals",
    note: "Safe proxy to backend when PCP_API_BASE_URL is configured.",
  },
  {
    name: "Token Scan",
    path: "/api/token-scan",
    note: "Safe proxy to backend when PCP_API_BASE_URL is configured.",
  },
  {
    name: "Code Audit",
    path: "/api/code-audit",
    note: "Safe proxy endpoint for external audit requests.",
  },
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <span className="eyebrow">PocketChange Protocol</span>
        <h1>Slopfest signal quota, shared capital allocation, and arb scouting in one demo surface.</h1>
        <p>
          This deployment gives <span className="code">pcprotocol.dev</span> a real Next.js app, a stable
          health endpoint, and Vercel-safe API entry points that can proxy to the backend stack when
          configured.
        </p>
        <div className="actions">
          <a className="button primary" href="/api/health">
            Check Health
          </a>
          <a
            className="button secondary"
            href="https://github.com/mmcneal2394/PocketChangeProtocol/pull/16"
            target="_blank"
            rel="noreferrer"
          >
            View Demo PR
          </a>
        </div>
      </section>

      <section className="grid">
        {statusCards.map((card) => (
          <article className="card" key={card.title}>
            <h2 className="section-title">{card.title}</h2>
            <p className="muted">{card.body}</p>
          </article>
        ))}
      </section>

      <section className="card">
        <h2 className="section-title">Deployment Expectations</h2>
        <div className="kpis">
          <div className="kpi">
            <strong>Project</strong>
            <span className="muted code">prj_vVwDvGwCjh0DX2jElHI8qkxfpoPR</span>
          </div>
          <div className="kpi">
            <strong>Domain</strong>
            <span className="muted code">pcprotocol.dev</span>
          </div>
          <div className="kpi">
            <strong>Root App</strong>
            <span className="muted">Next.js app router</span>
          </div>
          <div className="kpi">
            <strong>Backend Mode</strong>
            <span className="muted">Optional proxy via env</span>
          </div>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h3 className="section-title">API Surface</h3>
          <ul className="list">
            {serviceRows.map((row) => (
              <li key={row.path}>
                <span className="code">{row.path}</span>
                {" — "}
                {row.note}
              </li>
            ))}
          </ul>
        </article>

        <article className="card">
          <h3 className="section-title">What This Does Not Claim</h3>
          <ul className="list">
            <li>It does not claim live atomic arbitrage execution from the Vercel edge.</li>
            <li>It does not embed secrets or wallet material in the site bundle.</li>
            <li>It does not require the frontend to hold direct trading credentials.</li>
          </ul>
        </article>
      </section>

      <p className="footer">
        PocketChange Protocol demo deployment. For backend proxying, set
        {" "}
        <span className="code">PCP_API_BASE_URL</span>
        {" "}
        in the Vercel project environment.
      </p>
    </main>
  );
}
