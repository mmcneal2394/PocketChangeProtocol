# PCP Open Agent — Bitte Protocol Deployment

## What was built

```
bitte-agent/
├── public/.well-known/ai-plugin.json    ← Bitte plugin manifest
├── src/app/
│   ├── openapi.json/route.ts            ← Full OpenAPI spec with x-mb extension
│   └── api/
│       ├── token-scan/route.ts          ← GET /api/token-scan
│       ├── arb-windows/route.ts         ← GET /api/arb-windows
│       ├── alpha-signals/route.ts       ← GET /api/alpha-signals
│       ├── code-audit/route.ts          ← POST /api/code-audit
│       └── health/route.ts              ← GET /api/health
├── package.json
├── tsconfig.json
└── next.config.js
```

## Step 1 — Deploy to Vercel

```powershell
cd c:\pcprotocol\bitte-agent

# Install Vercel CLI if needed
npm install -g vercel

# Deploy (first time — follow prompts)
vercel

# After first deploy, get your URL (e.g. pcp-agent.vercel.app)
# Set environment variable:
vercel env add DEPLOYMENT_URL
# Enter: https://pcp-agent.vercel.app  (or your actual URL)

# Redeploy with env var
vercel --prod
```

## Step 2 — Update URLs (important)

After Vercel gives you a URL, update 2 files:

**`public/.well-known/ai-plugin.json`**
```json
"url": "https://YOUR-URL.vercel.app/openapi.json"
"logo_url": "https://YOUR-URL.vercel.app/logo.png"
```

**Then redeploy:**
```powershell
vercel --prod
```

## Step 3 — Register with make-agent

```powershell
cd c:\pcprotocol\bitte-agent
npx make-agent deploy
```

This validates your manifest and registers with Bitte registry.
You'll receive a debug URL:
```
https://wallet.bitte.ai/smart-actions/prompt/hey?mode=debug&agentId=YOUR-URL.vercel.app
```

## Step 4 — Test your agent

Open the debug URL in browser and test:
- "Show me trending Solana tokens"
- "Find arb windows with 0.5 SOL capital"
- "What alpha signals are active right now?"
- "Audit this code: [paste TypeScript]"

## Step 5 — Get Verified

Message Bitte team on Telegram: https://t.me/mintdev
Tell them: "PocketChange Protocol agent ready for verification — Solana DeFi analytics"

---

## Verify it's working (pre-deploy)

```powershell
cd c:\pcprotocol\bitte-agent
npm run dev
# Then open: http://localhost:3000/api/health
#            http://localhost:3000/.well-known/ai-plugin.json
#            http://localhost:3000/openapi.json
```
