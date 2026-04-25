import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import Redis from 'ioredis';
import { config } from 'dotenv';
import {
  buildWalletSignalArtifacts,
  createEmptyWalletSignalState,
  TrackedWalletMeta,
  WalletPnlRow,
  WalletSignalState,
  WalletSnapshot,
  TokenMetadata,
} from './wallet_signal_logic';
const { extractTrendingEntries } = require('./trending_signal_logic.ts');

config();

const ROOT_DIR = process.cwd();
const SIGNALS_DIR = path.join(ROOT_DIR, 'signals');
const STATE_FILE = path.join(SIGNALS_DIR, 'alpha_wallet_monitor_state.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');
const ALPHA_WALLETS_FILE = path.join(SIGNALS_DIR, 'alpha_wallets.json');
const KOL_WALLETS_FILE = path.join(SIGNALS_DIR, 'kol_wallets.json');
const WALLET_PNL_FILE = path.join(SIGNALS_DIR, 'wallet_pnl.json');
const WALLET_INTEL_FILE = path.join(SIGNALS_DIR, 'wallet_intel.json');
const TRENDING_FILE = path.join(SIGNALS_DIR, 'trending.json');
const GMGN_TRENDING_FILE = path.join(SIGNALS_DIR, 'gmgn_trending.json');
const ACTIVITY_FILE = path.join(SIGNALS_DIR, 'alpha_wallet_activity.jsonl');
const LIVE_STATE_FILE = path.join(SIGNALS_DIR, 'alpha_wallet_live_state.json');

const RPC_URL = (process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const ENV_WALLETS = JSON.parse(process.env.ALPHA_WALLETS || '[]') as string[];
const POLL_MS = Number(process.env.WALLET_MONITOR_POLL_MS || 30_000);
const BATCH_SIZE = Math.max(1, Number(process.env.WALLET_MONITOR_BATCH_SIZE || 4));
const INTER_WALLET_DELAY_MS = Math.max(0, Number(process.env.WALLET_MONITOR_INTER_WALLET_MS || 1000));

const redis = new Redis(REDIS_URL);
const connection = new Connection(RPC_URL, 'confirmed');
let walletBatchCursor = 0;

type WalletRegistryDocument = {
  tracked_wallets?: TrackedWalletMeta[];
};

function ensureSignalsDir(): void {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function loadJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: unknown): void {
  ensureSignalsDir();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendJsonLine(filePath: string, payload: unknown): void {
  ensureSignalsDir();
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function uniqueWallets(wallets: TrackedWalletMeta[]): TrackedWalletMeta[] {
  const byAddress = new Map<string, TrackedWalletMeta>();
  for (const wallet of wallets) {
    if (!wallet?.address) continue;
    const existing = byAddress.get(wallet.address);
    if (!existing) {
      byAddress.set(wallet.address, wallet);
      continue;
    }
    byAddress.set(wallet.address, {
      ...existing,
      ...wallet,
      style: wallet.style || existing.style,
      score: wallet.score ?? existing.score,
      weight: wallet.weight ?? existing.weight,
      executable: wallet.executable ?? existing.executable,
      immediate_entry: wallet.immediate_entry ?? existing.immediate_entry,
      preferred_hold_ms: wallet.preferred_hold_ms ?? existing.preferred_hold_ms,
    });
  }
  return Array.from(byAddress.values());
}

function loadTrackedWallets(): TrackedWalletMeta[] {
  const alphaDoc = loadJsonSafe<WalletRegistryDocument>(ALPHA_WALLETS_FILE, {});
  const kolDoc = loadJsonSafe<WalletRegistryDocument>(KOL_WALLETS_FILE, {});
  const intelDoc = loadJsonSafe<WalletRegistryDocument>(WALLET_INTEL_FILE, {});

  const seededEnv = ENV_WALLETS.map((address) => ({
    address,
    style: 'ENV',
    score: 0.55,
    weight: 0.55,
    executable: false,
    immediate_entry: false,
    preferred_hold_ms: 300000,
    source: 'env',
  }));

  const tracked = uniqueWallets([
    ...(alphaDoc.tracked_wallets || []),
    ...(kolDoc.tracked_wallets || []),
    ...(intelDoc.tracked_wallets || []),
    ...seededEnv,
  ]);

  if (tracked.length > 0) return tracked;

  console.warn('[MONITOR] No tracked alpha wallets found in env or signals registry.');
  return [];
}

function loadWalletPnlRows(): { summary: Record<string, any>; rows: WalletPnlRow[] } {
  const doc = loadJsonSafe<Record<string, any>>(WALLET_PNL_FILE, {});
  return {
    summary: doc,
    rows: Array.isArray(doc.wallets) ? (doc.wallets as WalletPnlRow[]) : [],
  };
}

function indexTrendingArray(entries: any[], index: Record<string, TokenMetadata>): void {
  for (const entry of entries || []) {
    const mint = entry?.mint || entry?.baseToken?.address;
    if (!mint) continue;
    index[mint] = {
      symbol: entry?.symbol || entry?.baseToken?.symbol || index[mint]?.symbol,
      name: entry?.name || entry?.baseToken?.name || index[mint]?.name,
      sector: entry?.sector || index[mint]?.sector || null,
    };
  }
}

function loadTokenMetadataIndex(): Record<string, TokenMetadata> {
  const index: Record<string, TokenMetadata> = {};
  const trending = loadJsonSafe<any>(TRENDING_FILE, []);
  const gmgnTrending = loadJsonSafe<any>(GMGN_TRENDING_FILE, {});
  indexTrendingArray(extractTrendingEntries(trending), index);
  indexTrendingArray(Array.isArray(gmgnTrending?.tokens) ? gmgnTrending.tokens : extractTrendingEntries(gmgnTrending), index);
  return index;
}

function selectWalletBatch(trackedWallets: TrackedWalletMeta[]): TrackedWalletMeta[] {
  if (trackedWallets.length <= BATCH_SIZE) return trackedWallets;
  const batch: TrackedWalletMeta[] = [];
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const index = (walletBatchCursor + i) % trackedWallets.length;
    batch.push(trackedWallets[index]);
  }
  walletBatchCursor = (walletBatchCursor + BATCH_SIZE) % trackedWallets.length;
  return batch;
}

async function fetchWalletSnapshot(walletAddress: string): Promise<WalletSnapshot> {
  const owner = new PublicKey(walletAddress);
  const parsed = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  const balances: Record<string, number> = {};
  for (const account of parsed.value) {
    const parsedData = account.account.data as any;
    const info = parsedData?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    const amount = Number(tokenAmount?.uiAmount || 0);
    const mint = info?.mint;
    if (!mint || !Number.isFinite(amount) || amount <= 0) continue;
    balances[mint] = (balances[mint] || 0) + amount;
  }

  return {
    wallet: walletAddress,
    balances,
    timestamp: Date.now(),
  };
}

function loadState(): WalletSignalState {
  return loadJsonSafe<WalletSignalState>(STATE_FILE, createEmptyWalletSignalState(Date.now()));
}

async function publishSnapshot(snapshot: WalletSnapshot): Promise<void> {
  await redis.publish('ALPHA_WALLET_UPDATE', JSON.stringify({
    wallet: snapshot.wallet,
    balances: snapshot.balances,
    timestamp: snapshot.timestamp,
  }));
}

async function publishSignalEvent(event: Record<string, any>): Promise<void> {
  await redis.publish('ALPHA_WALLET_SIGNAL', JSON.stringify(event));
}

async function runCycle(): Promise<void> {
  const trackedWallets = loadTrackedWallets();
  if (trackedWallets.length === 0) return;
  const cycleWallets = selectWalletBatch(trackedWallets);

  const tokenMetadata = loadTokenMetadataIndex();
  const walletPnl = loadWalletPnlRows();
  const previousState = loadState();
  const snapshots: WalletSnapshot[] = [];

  for (const wallet of cycleWallets) {
    try {
      const snapshot = await fetchWalletSnapshot(wallet.address);
      snapshots.push(snapshot);
      await publishSnapshot(snapshot);
      console.log(`[MONITOR] Published balances for ${wallet.address}`);
    } catch (error: any) {
      const message = error?.message || String(error);
      if (message.includes('429')) {
        console.warn(`[MONITOR] Rate limited while monitoring ${wallet.address}; keeping prior state and moving on.`);
      } else {
        console.error(`[MONITOR] Error monitoring wallet ${wallet.address}:`, message);
      }
    }
    if (INTER_WALLET_DELAY_MS > 0) {
      await sleep(INTER_WALLET_DELAY_MS);
    }
  }

  if (snapshots.length === 0) return;

  const artifacts = buildWalletSignalArtifacts({
    state: previousState,
    snapshots,
    trackedWallets,
    walletPnlRows: walletPnl.rows,
    walletPnlSummary: walletPnl.summary,
    tokenMetadata,
    now: Date.now(),
  });

  writeJson(STATE_FILE, artifacts.state);
  writeJson(WALLET_SIGNALS_FILE, {
    ...artifacts.document,
    generated_at: Date.now(),
    tracked_wallet_count: trackedWallets.length,
    cycle_wallet_count: cycleWallets.length,
  });
  writeJson(LIVE_STATE_FILE, {
    updated_at: Date.now(),
    tracked_wallets: trackedWallets,
    balances_by_wallet: artifacts.state.balancesByWallet,
    open_positions: artifacts.state.positionsByWalletMint,
  });

  for (const event of artifacts.emittedEvents) {
    appendJsonLine(ACTIVITY_FILE, event);
    await publishSignalEvent(event);
  }

  const executableSignals = artifacts.document.buy_signals.filter((signal) => signal.executable).length;
  const activeSells = artifacts.document.sell_signals.length;
  console.log(`[MONITOR] Wallet intel updated | batch=${cycleWallets.length}/${trackedWallets.length} buys=${artifacts.document.buy_signals.length} executable=${executableSignals} sells=${activeSells}`);
}

async function mainLoop(): Promise<void> {
  ensureSignalsDir();
  console.log('[MONITOR] Starting alpha wallet monitor');
  while (true) {
    try {
      await runCycle();
    } catch (error: any) {
      console.error('[MONITOR] Cycle failure:', error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

mainLoop().catch(console.error);

setInterval(() => {
  redis.publish('HEARTBEAT', JSON.stringify({
    agent: 'wallet-monitor',
    status: 'alive',
    trackedWallets: loadTrackedWallets().length,
  })).catch(() => {});
}, 10_000);
