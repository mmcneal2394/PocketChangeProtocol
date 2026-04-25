import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Connection, LogsCallback, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';
import { extractTrendingEntries } from './trending_signal_logic';
import {
  extractCandidateMintsFromParsedTx,
  buildBagsTrendingEntry,
  estimateBagsVelocitySignal,
} from './bags_swarm_logic';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const TRENDING_FILE = path.join(SIGNALS_DIR, 'trending.json');
const BAGS_SWARM_FILE = path.join(SIGNALS_DIR, 'bags_swarm.json');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const PROGRAMS = [
  { name: 'raydium-v4', id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
  { name: 'pumpfun', id: '6EF8rrecthR5DkdfiS9KYQaM21LCZZbNcc1tY8ZhuHF' },
  { name: 'moonshot', id: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMag4y1DtUTn5Ad' },
  { name: 'bags-fm', id: 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK' },
  { name: 'meteora', id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' },
];

const RPC_HTTP = process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RPC_WS = process.env.RPC_WS_ENDPOINT || RPC_HTTP.replace(/^http/i, 'ws');
const SOL_PRICE_USD = Number(process.env.SOL_PRICE_USD || 150);
const MAX_RECENT_LAUNCHES = 200;
const MAX_SEEN_SIGNATURES = 2000;
const MAX_QUEUE_LENGTH = Math.max(50, Number(process.env.BAGS_SWARM_MAX_QUEUE || 250));
const PROCESS_DELAY_MS = Math.max(100, Number(process.env.BAGS_SWARM_PROCESS_DELAY_MS || 350));

if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

const connection = new Connection(RPC_HTTP, {
  wsEndpoint: RPC_WS,
  commitment: 'confirmed',
});

const seenSignatures = new Set<string>();
const pendingSignatures = new Set<string>();
const queuedSignatures = new Set<string>();
const signatureQueue: Array<{ signature: string; launchpad: string }> = [];
let queueDrainInFlight = false;

function rememberSignature(signature: string) {
  seenSignatures.add(signature);
  if (seenSignatures.size <= MAX_SEEN_SIGNATURES) return;
  const first = seenSignatures.values().next().value;
  if (first) seenSignatures.delete(first);
}

function safeWrite(filePath: string, payload: any) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBagsDexPair(mint: string) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.pairs) || data.pairs.length === 0) return null;
    const bagsPairs = data.pairs.filter((pair: any) => pair?.dexId === 'bags-fm');
    if (bagsPairs.length === 0) return null;
    const pair = bagsPairs.sort((a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
    return {
      mint,
      symbol: pair?.baseToken?.symbol || `${mint.slice(0, 8)}...`,
      name: pair?.baseToken?.name || pair?.baseToken?.symbol || mint,
      url: pair?.url,
      dexId: pair?.dexId || 'bags-fm',
      liquidityUsd: Number(pair?.liquidity?.usd || 0),
      volume1h: Number(pair?.volume?.h1 || 0),
      volume5m: Number(pair?.volume?.m5 || 0),
      priceChange1h: Number(pair?.priceChange?.h1 || 0),
      priceChange5m: Number(pair?.priceChange?.m5 || 0),
      fdvUsd: Number(pair?.fdv || pair?.marketCap || 0),
      pairCreatedAt: Number(pair?.pairCreatedAt || pair?.createdAt || 0) || undefined,
      buys1h: Number(pair?.txns?.h1?.buys || 0),
      sells1h: Number(pair?.txns?.h1?.sells || 0),
    };
  } catch {
    return null;
  }
}

function upsertTrendingEntry(entry: any) {
  let existing = [];
  try {
    if (fs.existsSync(TRENDING_FILE)) {
      existing = extractTrendingEntries(JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8')));
    }
  } catch {
    existing = [];
  }

  const mint = entry?.baseToken?.address;
  const next = existing.filter((item: any) => (item?.baseToken?.address || item?.mint) !== mint);
  next.push(entry);
  safeWrite(TRENDING_FILE, next);
  return next.length;
}

function appendLaunchRecord(payload: any) {
  let existing: any = { updatedAt: 0, launches: [] };
  try {
    if (fs.existsSync(BAGS_SWARM_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BAGS_SWARM_FILE, 'utf-8'));
      if (raw && typeof raw === 'object') existing = raw;
    }
  } catch {}

  const launches = Array.isArray(existing.launches) ? existing.launches : [];
  launches.unshift(payload);
  existing.updatedAt = Date.now();
  existing.launches = launches.slice(0, MAX_RECENT_LAUNCHES);
  safeWrite(BAGS_SWARM_FILE, existing);
}

async function publishVelocityHint(pair: any) {
  const publisher = RedisBus.getPublisher();
  const velocity = estimateBagsVelocitySignal(pair, Date.now(), SOL_PRICE_USD);
  await publisher.publish(CHANNELS.VELOCITY_SPIKE, JSON.stringify({
    updatedAt: Date.now(),
    source: 'bags-swarm',
    mints: {
      [pair.mint]: velocity,
    },
  }));
}

async function getParsedTransactionWithRetry(signature: string, attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) return tx as ParsedTransactionWithMeta;
      await sleep(600 + (i * 400));
    } catch (error: any) {
      const message = String(error?.message || error || '');
      const backoffMs = message.includes('429') ? (i + 1) * 2500 : 800 + (i * 500);
      console.warn(`[BAGS-SWARM] tx fetch retry ${i + 1}/${attempts} for ${signature.slice(0, 8)}... after ${backoffMs}ms (${message.slice(0, 120)})`);
      await sleep(backoffMs);
    }
  }
  return null;
}

async function processSignature(signature: string, launchpad: string) {
  if (pendingSignatures.has(signature) || seenSignatures.has(signature)) return;
  pendingSignatures.add(signature);
  try {
    const parsedTx = await getParsedTransactionWithRetry(signature);
    if (!parsedTx) return;

    const candidateMints = extractCandidateMintsFromParsedTx(parsedTx);
    if (candidateMints.length === 0) return;

    for (const mint of candidateMints) {
      if (mint === SOL_MINT) continue;
      const pair = await fetchBagsDexPair(mint);
      if (!pair) continue;

      const trendingEntry = buildBagsTrendingEntry(pair, {
        source: 'bags-swarm',
        signature,
        launchpad,
      });
      const totalTrending = upsertTrendingEntry(trendingEntry);
      appendLaunchRecord({
        detectedAt: Date.now(),
        launchpad,
        signature,
        mint: pair.mint,
        symbol: pair.symbol,
        dexId: pair.dexId,
        liquidityUsd: pair.liquidityUsd,
        volume1h: pair.volume1h,
        volume5m: pair.volume5m,
        pairCreatedAt: pair.pairCreatedAt || null,
      });
      await publishVelocityHint(pair);
      console.log(
        `[BAGS-SWARM] ${launchpad} -> ${pair.symbol} ${pair.mint.slice(0, 8)}... ` +
        `| liq $${pair.liquidityUsd.toFixed(0)} | vol5m $${pair.volume5m.toFixed(0)} | trending ${totalTrending}`
      );
      return;
    }
  } catch (error: any) {
    console.error(`[BAGS-SWARM] process error for ${signature.slice(0, 8)}...: ${error.message}`);
  } finally {
    pendingSignatures.delete(signature);
    rememberSignature(signature);
  }
}

async function drainQueue() {
  if (queueDrainInFlight) return;
  queueDrainInFlight = true;
  try {
    while (signatureQueue.length > 0) {
      const next = signatureQueue.shift();
      if (!next) continue;
      queuedSignatures.delete(next.signature);
      await processSignature(next.signature, next.launchpad);
      await sleep(PROCESS_DELAY_MS);
    }
  } finally {
    queueDrainInFlight = false;
  }
}

function enqueueSignature(signature: string, launchpad: string) {
  if (!signature || seenSignatures.has(signature) || pendingSignatures.has(signature) || queuedSignatures.has(signature)) {
    return;
  }
  if (signatureQueue.length >= MAX_QUEUE_LENGTH) {
    const dropped = signatureQueue.shift();
    if (dropped) queuedSignatures.delete(dropped.signature);
  }
  signatureQueue.push({ signature, launchpad });
  queuedSignatures.add(signature);
  void drainQueue();
}

async function main() {
  console.log(`[BAGS-SWARM] Starting cross-launchpad Bags detector on ${RPC_HTTP}`);
  console.log(`[BAGS-SWARM] Watching ${PROGRAMS.map((program) => program.name).join(', ')}`);

  const makeHandler = (launchpad: string): LogsCallback => async (logs) => {
    try {
      if (!logs?.signature) return;
      enqueueSignature(logs.signature, launchpad);
    } catch (error: any) {
      console.error(`[BAGS-SWARM] handler error (${launchpad}): ${error.message}`);
    }
  };

  for (const program of PROGRAMS) {
    connection.onLogs(new PublicKey(program.id), makeHandler(program.name), 'confirmed');
  }

  setInterval(() => {
    console.log(`[BAGS-SWARM] heartbeat | seen=${seenSignatures.size} queued=${signatureQueue.length} pending=${pendingSignatures.size}`);
  }, 120_000);
}

main().catch((error) => {
  console.error('[BAGS-SWARM] fatal:', error);
  process.exit(1);
});
