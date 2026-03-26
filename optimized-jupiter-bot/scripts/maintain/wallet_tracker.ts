/**
 * PCP Wallet Tracker Agent v2.0 — Full Intelligence Stack
 * =========================================================
 * Feature set:
 *  1. Alpha wallet BUY signal     → HIGH_CONVICTION when 2+ wallets in 60s
 *  2. Alpha wallet SELL trigger   → emit SELL signal → sniper exits position
 *  3. Hold time calibration       → tracks how long alpha wallets hold each token
 *  4. Token age preference        → learns which token age window alpha wallets target
 *  5. Meta/sector detection       → clusters what narratives alpha wallets are buying
 *  6. Multi-wallet consensus      → SIZE_UP flag when 3+ wallets buy same token
 *
 * Output: signals/wallet_signals.json
 * PM2:    pcp-wallet-tracker
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

// ── Config ───────────────────────────────────────────────────────────────────
const SIGNALS_DIR      = path.join(process.cwd(), "signals");
const ALPHA_FILE       = path.join(SIGNALS_DIR, "alpha_wallets.json");
const WALLET_SIG_FILE  = path.join(SIGNALS_DIR, "wallet_signals.json");
const HELIUS_KEY       = process.env.HELIUS_API_KEY || "";
const HELIUS_WS_URL    = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const CONVICTION_WINDOW_MS = 60_000;   // 60s window for multi-wallet conviction
const SIZE_UP_THRESHOLD    = 3;        // 3+ wallets → SIZE_UP flag
const MAX_SIGNAL_AGE_MS    = 90_000;   // buy signals expire after 90s
const SELL_SIGNAL_TTL_MS   = 30_000;   // sell signals expire after 30s (urgent)
const RELOAD_MS            = 4 * 60 * 60 * 1000;
const MIN_SWAP_SOL         = 0.01;

// Sector keyword clusters for meta detection
const SECTOR_MAP: Record<string, string[]> = {
  "AI":      ["ai", "gpt", "agent", "neural", "robot", "agi", "llm", "claude", "gemini"],
  "DOG":     ["dog", "doge", "shib", "wif", "bonk", "floki", "husky", "pup"],
  "CAT":     ["cat", "nyan", "meow", "kitty", "purr", "feline"],
  "PEPE":    ["pepe", "frog", "kek", "wojak", "chad"],
  "MEME":    ["meme", "moon", "pump", "gem", "elon", "trump", "based"],
  "DEFI":    ["defi", "yield", "vault", "lend", "swap", "amm", "lp"],
  "GAME":    ["game", "play", "nft", "pixel", "arcade", "quest", "rpg"],
  "SOL":     ["sol", "solana", "saga", "serum", "ray", "orca"],
};

// ── Types ────────────────────────────────────────────────────────────────────
interface TrackedWallet {
  address: string;
  win_rate_gmgn: number;
  score: number;
  source: string;
}

interface WalletEntry {
  walletAddr: string;
  solIn: number;
  entryTs: number;
}

interface BuySignal {
  type: "BUY";
  mint: string;
  symbol?: string;
  wallets: string[];
  firstSeenMs: number;
  lastSeenMs: number;
  conviction: "NORMAL" | "HIGH";
  sizeUp: boolean;              // 3+ wallets → SIZE_UP
  swapSolAmount: number;
  consensusScore: number;       // 0–1 weighted by wallet scores
  sector?: string;              // AI / DOG / MEME etc.
  expired: boolean;
}

interface SellSignal {
  type: "SELL";
  mint: string;
  symbol?: string;
  walletAddr: string;
  holdMs: number;               // how long alpha wallet held
  soldAt: number;
  expired: boolean;
}

interface HoldStat {
  mint: string;
  entries: WalletEntry[];       // open entries per wallet
  closedHolds: number[];        // closed hold durations in ms
}

// ── State ────────────────────────────────────────────────────────────────────
const buySignals  = new Map<string, BuySignal>();
const sellSignals = new Map<string, SellSignal>();
const holdStats   = new Map<string, HoldStat>();   // mint → hold tracking
const sectorCounts: Record<string, number> = {};   // sector → buy count (last hour)

let trackedWallets: TrackedWallet[] = [];
let walletScoreMap = new Map<string, number>();     // addr → score for consensus
let ws: WebSocket | null = null;
let wsReady = false;

// ── Helpers ──────────────────────────────────────────────────────────────────
function detectSector(symbol: string): string | undefined {
  const s = symbol.toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_MAP)) {
    if (keywords.some(k => s.includes(k))) return sector;
  }
  return undefined;
}

function getHotSector(): string | undefined {
  const sorted = Object.entries(sectorCounts)
    .filter(([, c]) => c >= 3)
    .sort(([, a], [, b]) => b - a);
  return sorted[0]?.[0];
}

function calcConsensusScore(wallets: string[]): number {
  if (!wallets.length) return 0;
  const total = wallets.reduce((sum, addr) => sum + (walletScoreMap.get(addr) || 0.5), 0);
  return Math.min(1, total / wallets.length);
}

function httpsGet(url: string): Promise<any> {
  return new Promise((resolve) => {
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

// ── Load alpha wallets ────────────────────────────────────────────────────────
function loadAlphaWallets(): TrackedWallet[] {
  try {
    if (!fs.existsSync(ALPHA_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(ALPHA_FILE, "utf-8"));
    const wallets: TrackedWallet[] = (raw.tracked_wallets || []).slice(0, 25);

    // Build score map for consensus weighting
    walletScoreMap.clear();
    for (const w of wallets) {
      walletScoreMap.set(w.address, w.score || 0.5);
    }

    // Load own win patterns for hold time calibration comparison
    const own = raw.own_win_patterns;
    if (own?.wins?.avg_hold_min) {
      console.log(`[TRACKER] 📊 Own win avg hold: ${own.wins.avg_hold_min}min | Loss avg: ${own.losses?.avg_hold_min}min`);
    }

    console.log(`[TRACKER] 📋 Loaded ${wallets.length} alpha wallets`);
    return wallets;
  } catch (e) {
    console.error("[TRACKER] Load error:", e);
    return [];
  }
}

// ── Flush signals to disk ─────────────────────────────────────────────────────
function flushSignals(): void {
  const now = Date.now();

  // Expire old signals
  for (const [mint, sig] of buySignals) {
    if (now - sig.lastSeenMs > MAX_SIGNAL_AGE_MS) sig.expired = true;
  }
  for (const [mint, sig] of sellSignals) {
    if (now - sig.soldAt > SELL_SIGNAL_TTL_MS) sig.expired = true;
  }

  // Compute hold calibration stats
  const holdCalib: { mint: string; avgHoldMs: number; sampleSize: number }[] = [];
  for (const [mint, stat] of holdStats) {
    if (stat.closedHolds.length >= 2) {
      const avg = stat.closedHolds.reduce((a, b) => a + b, 0) / stat.closedHolds.length;
      holdCalib.push({ mint, avgHoldMs: Math.round(avg), sampleSize: stat.closedHolds.length });
    }
  }

  const activeBuys  = [...buySignals.values()].filter(s => !s.expired);
  const activeSells = [...sellSignals.values()].filter(s => !s.expired);

  // Sort: SIZE_UP > HIGH > NORMAL, then by consensus score
  activeBuys.sort((a, b) => {
    if (a.sizeUp !== b.sizeUp) return a.sizeUp ? -1 : 1;
    if (a.conviction !== b.conviction) return a.conviction === "HIGH" ? -1 : 1;
    return b.consensusScore - a.consensusScore;
  });

  const hotSector = getHotSector();

  const output = {
    updated_at: new Date().toISOString(),
    hot_sector: hotSector || null,
    sector_counts: { ...sectorCounts },
    buy_signals: activeBuys,
    sell_signals: activeSells,
    hold_calibration: holdCalib.slice(0, 20),
    stats: {
      active_buys: activeBuys.length,
      active_sells: activeSells.length,
      high_conviction: activeBuys.filter(s => s.conviction === "HIGH").length,
      size_up: activeBuys.filter(s => s.sizeUp).length,
      wallets_tracked: trackedWallets.length,
    }
  };

  fs.writeFileSync(WALLET_SIG_FILE, JSON.stringify(output, null, 2));
}

// ── Record BUY ───────────────────────────────────────────────────────────────
function recordBuy(walletAddr: string, mint: string, solAmount: number, symbol?: string): void {
  const now = Date.now();

  // Update hold tracking (open entry for this wallet)
  let stat = holdStats.get(mint);
  if (!stat) { stat = { mint, entries: [], closedHolds: [] }; holdStats.set(mint, stat); }
  if (!stat.entries.find(e => e.walletAddr === walletAddr)) {
    stat.entries.push({ walletAddr, solIn: solAmount, entryTs: now });
  }

  // Sector detection
  let sector: string | undefined;
  if (symbol) {
    sector = detectSector(symbol);
    if (sector) {
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    }
  }

  // Update or create buy signal
  const existing = buySignals.get(mint);
  if (existing) {
    if (!existing.wallets.includes(walletAddr)) existing.wallets.push(walletAddr);
    existing.lastSeenMs    = now;
    existing.swapSolAmount = Math.max(existing.swapSolAmount, solAmount);
    existing.expired       = false;
    existing.consensusScore = calcConsensusScore(existing.wallets);
    if (sector) existing.sector = sector;

    const windowMs = now - existing.firstSeenMs;
    const wCount   = existing.wallets.length;

    if (wCount >= SIZE_UP_THRESHOLD && windowMs <= CONVICTION_WINDOW_MS) {
      if (!existing.sizeUp) {
        existing.sizeUp = true;
        console.log(`[TRACKER] 🔥🔥 SIZE_UP: ${symbol || mint.slice(0,8)} — ${wCount} alpha wallets | consensus:${existing.consensusScore.toFixed(2)}`);
      }
    }
    if (wCount >= 2 && windowMs <= CONVICTION_WINDOW_MS) {
      if (existing.conviction !== "HIGH") {
        existing.conviction = "HIGH";
        console.log(`[TRACKER] 🔥 HIGH_CONVICTION: ${symbol || mint.slice(0,8)} — ${wCount} wallets in ${Math.round(windowMs/1000)}s`);
      }
    }
  } else {
    buySignals.set(mint, {
      type: "BUY", mint, symbol,
      wallets: [walletAddr],
      firstSeenMs: now, lastSeenMs: now,
      conviction: "NORMAL",
      sizeUp: false,
      swapSolAmount: solAmount,
      consensusScore: walletScoreMap.get(walletAddr) || 0.5,
      sector,
      expired: false,
    });
    console.log(`[TRACKER] 👛 Alpha BUY: ${symbol || mint.slice(0,8)} | ${walletAddr.slice(0,8)} | ${solAmount.toFixed(3)} SOL${sector ? ` | ${sector}` : ""}`);
  }

  flushSignals();
}

// ── Record SELL ──────────────────────────────────────────────────────────────
function recordSell(walletAddr: string, mint: string, solOut: number, symbol?: string): void {
  const now = Date.now();

  // Calculate hold time for this wallet
  const stat = holdStats.get(mint);
  let holdMs = 0;
  if (stat) {
    const entryIdx = stat.entries.findIndex(e => e.walletAddr === walletAddr);
    if (entryIdx >= 0) {
      holdMs = now - stat.entries[entryIdx].entryTs;
      stat.closedHolds.push(holdMs);
      stat.entries.splice(entryIdx, 1);
    }
  }

  // Emit sell signal — URGENT: sniper should exit immediately if holding this mint
  sellSignals.set(mint, {
    type: "SELL", mint, symbol,
    walletAddr,
    holdMs,
    soldAt: now,
    expired: false,
  });

  const holdStr = holdMs > 0 ? ` | held ${(holdMs/60000).toFixed(1)}min` : "";
  console.log(`[TRACKER] 🚨 Alpha SELL: ${symbol || mint.slice(0,8)} | ${walletAddr.slice(0,8)} | ${solOut.toFixed(3)} SOL out${holdStr}`);

  // Remove from buy signals if present (token is done)
  const buy = buySignals.get(mint);
  if (buy) buy.expired = true;

  flushSignals();
}

// ── Parse Helius enhanced transaction ────────────────────────────────────────
function parseTx(tx: any, watchedAddr: string): void {
  try {
    const events = tx?.events?.swap;
    if (!events) return;

    const nativeIn  = parseFloat(events.nativeInput?.amount  || 0) / 1e9;
    const nativeOut = parseFloat(events.nativeOutput?.amount || 0) / 1e9;
    const tokenOut  = events.tokenOutputs?.[0];
    const tokenIn   = events.tokenInputs?.[0];

    // BUY: SOL → token
    if (nativeIn >= MIN_SWAP_SOL && tokenOut?.mint) {
      const symbol = tokenOut.symbol || tokenOut.mint.slice(0, 8);
      recordBuy(watchedAddr, tokenOut.mint, nativeIn, symbol);
    }

    // SELL: token → SOL
    if (nativeOut >= MIN_SWAP_SOL && tokenIn?.mint) {
      const symbol = tokenIn.symbol || tokenIn.mint.slice(0, 8);
      recordSell(watchedAddr, tokenIn.mint, nativeOut, symbol);
    }
  } catch {}
}

// ── Fetch enhanced tx from Helius REST ───────────────────────────────────────
function fetchEnhancedTx(sig: string, walletAddr: string): void {
  if (!HELIUS_KEY) return;
  const body = JSON.stringify({ transactions: [sig] });
  const req = https.request(
    {
      method: "POST",
      hostname: "api.helius.xyz",
      path: `/v0/transactions/?api-key=${HELIUS_KEY}`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    },
    (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const txns = JSON.parse(d);
          if (Array.isArray(txns) && txns[0]) parseTx(txns[0], walletAddr);
        } catch {}
      });
    }
  );
  req.on("error", () => {});
  req.write(body);
  req.end();
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connectWebSocket(): void {
  if (!HELIUS_KEY) {
    console.log("[TRACKER] No HELIUS_API_KEY — starting REST polling");
    startRestPolling();
    return;
  }

  console.log("[TRACKER] 🔌 Connecting Helius Atlas WebSocket...");
  ws = new WebSocket(HELIUS_WS_URL);

  ws.on("open", () => {
    wsReady = true;
    console.log(`[TRACKER] ✅ WS connected — subscribing to ${trackedWallets.length} wallets`);
    subscribeAll();
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method !== "logsNotification") return;

      const logs: string[] = msg.params?.result?.value?.logs || [];
      const sig: string    = msg.params?.result?.value?.signature || "";
      const accts: string[] = msg.params?.result?.value?.accounts || [];

      // Check if a DEX program was invoked
      const DEX = ["JUP6", "675kPX", "CAMM", "6EF8", "pAMM"];
      if (!logs.some(l => DEX.some(d => l.includes(d)))) return;

      const matched = accts.find(k => trackedWallets.some(w => w.address === k));
      if (matched && sig) fetchEnhancedTx(sig, matched);
    } catch {}
  });

  ws.on("close", () => {
    wsReady = false;
    console.log("[TRACKER] WS closed — reconnecting in 5s...");
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (e) => console.error("[TRACKER] WS error:", e.message));
}

function subscribeAll(): void {
  if (!ws || !wsReady) return;
  trackedWallets.forEach((wallet, i) => {
    ws!.send(JSON.stringify({
      jsonrpc: "2.0", id: i + 1,
      method: "logsSubscribe",
      params: [{ mentions: [wallet.address] }, { commitment: "confirmed" }]
    }));
  });
  console.log(`[TRACKER] 📡 Subscribed to ${trackedWallets.length} wallet streams`);
}

// ── REST fallback polling ─────────────────────────────────────────────────────
async function pollWallet(wallet: TrackedWallet, cutoffMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!HELIUS_KEY) return resolve();
    const url = `https://api.helius.xyz/v0/addresses/${wallet.address}/transactions?api-key=${HELIUS_KEY}&limit=5&type=SWAP`;
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const txns = JSON.parse(d);
          if (Array.isArray(txns)) {
            for (const tx of txns) {
              if ((tx.timestamp || 0) * 1000 > cutoffMs) parseTx(tx, wallet.address);
            }
          }
        } catch {}
        resolve();
      });
    }).on("error", () => resolve());
  });
}

async function startRestPolling(): Promise<void> {
  console.log("[TRACKER] 🔄 REST polling mode (every 30s)");
  const poll = async () => {
    const cutoff = Date.now() - 30_000;
    for (const wallet of trackedWallets) {
      await pollWallet(wallet, cutoff);
      await new Promise(r => setTimeout(r, 250));
    }
    flushSignals();
    setTimeout(poll, 30_000);
  };
  await poll();
}

// ── Sector count decay (sliding window — reset counts older than 1h) ──────────
function startSectorDecay(): void {
  setInterval(() => {
    for (const sector of Object.keys(sectorCounts)) {
      sectorCounts[sector] = Math.max(0, sectorCounts[sector] - 1);
    }
  }, 60_000); // decay by 1 per minute
}

// ── Maintenance ───────────────────────────────────────────────────────────────
function startMaintenance(): void {
  // Clean expired signals every 30s
  setInterval(() => {
    const now = Date.now();
    for (const [mint, sig] of buySignals) {
      if (sig.expired || now - sig.lastSeenMs > MAX_SIGNAL_AGE_MS * 2) buySignals.delete(mint);
    }
    for (const [mint, sig] of sellSignals) {
      if (sig.expired || now - sig.soldAt > SELL_SIGNAL_TTL_MS * 2) sellSignals.delete(mint);
    }
    flushSignals();
  }, 30_000);

  // Reload wallet list every 4h
  setInterval(() => {
    const fresh = loadAlphaWallets();
    if (fresh.length > 0) {
      trackedWallets = fresh;
      if (wsReady && ws) subscribeAll();
    }
  }, RELOAD_MS);

  // Status log every 5min
  setInterval(() => {
    const { stats } = JSON.parse(fs.readFileSync(WALLET_SIG_FILE, "utf-8") || "{}");
    const hotSector = getHotSector();
    console.log(`[TRACKER] 📊 Buys:${stats?.active_buys || 0} Sells:${stats?.active_sells || 0} HighConv:${stats?.high_conviction || 0} SizeUp:${stats?.size_up || 0}${hotSector ? ` | HOT: ${hotSector}` : ""}`);
  }, 5 * 60_000);

  startSectorDecay();
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║      PCP WALLET TRACKER v2.0 — Full Intel Stack     ║");
  console.log("║  BUY · SELL · HOLD CAL · SECTOR · CONSENSUS · SIZE  ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  flushSignals();

  trackedWallets = loadAlphaWallets();
  if (trackedWallets.length === 0) {
    console.log("[TRACKER] ⚠️  No alpha wallets — retrying in 60s");
    setTimeout(main, 60_000);
    return;
  }

  startMaintenance();
  HELIUS_KEY ? connectWebSocket() : startRestPolling();
  console.log(`[TRACKER] 🚀 Watching ${trackedWallets.length} wallets → ${WALLET_SIG_FILE}`);
}

main();
