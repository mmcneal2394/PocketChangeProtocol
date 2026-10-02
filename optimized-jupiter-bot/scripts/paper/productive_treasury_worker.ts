import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { PublicKey } from '@solana/web3.js';
import {
  buildProductiveTreasurySnapshot,
  ProductiveCandidate,
  ProductiveMarketEvidence,
  ProductivePolicy,
  ProductiveSourceSnapshot,
  validateProductiveSource,
} from './productive_treasury';

const { Providers, SOL, validateMint } = require('./live_providers');
const { atomic } = require('./provider_trial');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'artifacts/paper');
const STATE_FILE = path.join(DIR, 'productive-treasury.json');
const EVENT_FILE = path.join(DIR, 'productive-treasury.events.jsonl');
const LOCK_FILE = path.join(DIR, 'productive-treasury.lock');
const CONFIG_FILE = process.env.PRODUCTIVE_TOKEN_CONFIG || path.join(ROOT, 'config/productive-token-sources.json');
const POLL_MS = Math.max(60000, Number(process.env.PRODUCTIVE_TREASURY_POLL_MS || 300000));
const QUOTE_LAMPORTS = 10_000_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Bounded parallelism for the treasury's per-source and per-mint work. The
// shared provider layer enforces rate gaps, so overlapping only fills the
// waits that were previously spent serializing across ~52 candidates.
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function safeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validMint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

async function getJson(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('productive_source_requires_https');
  const response = await fetch(parsed.href, { timeout: 10000, redirect: 'error', size: 4_000_000 });
  if (!response.ok) throw new Error(`productive_source_http_${response.status}`);
  return response.json();
}

function recordDays(createdAt: unknown, now: number): number {
  const numeric = safeNumber(createdAt);
  const timestamp = numeric != null
    ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
    : Date.parse(String(createdAt || ''));
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86400000) : 0;
}

function cleanSymbol(value: unknown): string {
  return String(value || '').trim().replace(/^\$/, '').slice(0, 32);
}

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const CRYPTO_UNDERLYINGS = new Set(['BTC', 'ETH', 'LTC', 'XMR', 'ZEC', 'SOL', 'WBTC', 'WETH', 'TBTC', 'CBTC']);

export function payoutAssetCategory(mint: unknown, symbol: unknown, fallback = 'tokenized-asset'): string {
  const normalized = cleanSymbol(symbol).toUpperCase();
  if (mint === WRAPPED_SOL && normalized === 'SOL') return 'wrapped-native-crypto';
  if (CRYPTO_UNDERLYINGS.has(normalized) || /^(W|T|CB)?(BTC|ETH|LTC|XMR|ZEC)$/.test(normalized)) {
    // A crypto ticker on Solana is a representation until its bridge, reserve,
    // or canonical issuer relationship is independently verified.
    return 'crypto-representation';
  }
  return fallback;
}

function isCryptoPayout(mint: unknown, symbol: unknown): boolean {
  return ['wrapped-native-crypto', 'crypto-representation'].includes(payoutAssetCategory(mint, symbol));
}

export function normalizeOtcCandidates(coinsPayload: any, rewardsPayload: any, source: any, now: number): ProductiveCandidate[] {
  if (!Array.isArray(coinsPayload?.coins) || !Array.isArray(rewardsPayload?.top)) throw new Error('invalid_otc_registry');
  const current = new Map<string, any>();
  for (const coin of coinsPayload.coins) if (validMint(coin?.mint)) current.set(coin.mint, coin);
  const ranked: any[] = [];
  const seen = new Set<string>();
  for (const payout of rewardsPayload.top) {
    if (!validMint(payout?.mint) || seen.has(payout.mint)) continue;
    ranked.push({ ...(current.get(payout.mint) || {}), ...payout, payoutRecord: payout });
    seen.add(payout.mint);
  }
  for (const coin of current.values()) {
    if (seen.has(coin.mint)) continue;
    ranked.push(coin);
    seen.add(coin.mint);
  }
  const limit = Math.max(1, Math.min(100, Number(source.limit || 20)));
  return ranked.slice(0, limit).map(coin => {
    const rewardMints = [...new Set([...(Array.isArray(coin.rewardBasket) ? coin.rewardBasket : []), coin.rewardMint].filter(validMint))];
    const primarySymbol = cleanSymbol(coin.rewardSymbol || coin.pairSymbol);
    const payoutAssets = rewardMints.map((mint, index) => ({
      mint,
      symbol: index === 0 && primarySymbol ? primarySymbol : `asset-${index + 1}`,
      category: payoutAssetCategory(mint, index === 0 ? primarySymbol : '', 'tokenized-asset'),
      issuer: 'otc-declared',
    }));
    const payoutRecord = coin.payoutRecord;
    return {
      mint: coin.mint,
      symbol: cleanSymbol(coin.symbol),
      name: String(coin.name || coin.symbol || '').trim().slice(0, 96),
      sourceId: source.id,
      sourceKind: source.kind,
      observedAt: now,
      payout: {
        assets: payoutAssets,
        completedCycles: Math.max(0, Number(coin.rewardCycle || 0)),
        recordDays: recordDays(coin.createdAt, now),
        // The public leaderboard is token-level evidence, but it does not expose
        // transaction receipts. Keep admission closed until receipts are available.
        receiptsVerified: false,
        lastPayoutAt: payoutRecord && Number(rewardsPayload.lastDistributedAt || 0) > 0
          ? Number(rewardsPayload.lastDistributedAt) * 1000
          : null,
      },
      protocol: {
        projectScore: payoutAssets.length && primarySymbol ? 60 : 35,
        firewallPass: false,
      },
      raw: {
        venue: coin.venue || 'pumpfun',
        sourceMarket: coin.snapshot || null,
        payoutRecord: payoutRecord ? {
          distributedRaw: String(payoutRecord.distributed || 0),
          holdersPaid: Number(payoutRecord.holdersPaid || 0),
        } : null,
      },
    };
  });
}

async function loadOtcSource(source: any, now: number): Promise<ProductiveSourceSnapshot> {
  const base = new URL(source.baseUrl || 'https://otcdesks.cash');
  if (base.protocol !== 'https:' || base.hostname !== 'otcdesks.cash') throw new Error('invalid_otc_base_url');
  const [coins, rewards] = await Promise.all([
    getJson(new URL('/api/coins', base).href),
    getJson(new URL('/api/rewards', base).href),
  ]);
  const candidates = normalizeOtcCandidates(coins, rewards, source, now);
  return validateProductiveSource({
    schemaVersion: 'pcp-productive-source/v1',
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    status: 'fresh',
    detail: `${candidates.length} OTC payout/current-launch token(s); public payout totals are watch evidence, not transaction receipts`,
    candidates,
  });
}

export function normalizeX7Candidates(payload: any, source: any, now: number): ProductiveCandidate[] {
  if (!Array.isArray(payload?.coins)) throw new Error('invalid_x7_registry');
  const limit = Math.max(1, Math.min(100, Number(source.limit || 20)));
  const cryptoPayoutLimit = Math.max(1, Math.min(100, Number(source.cryptoPayoutLimit || 30)));
  const ranked = payload.coins
    .filter((coin: any) => coin?.rewardsTarget === 'holders' && validMint(coin?.mint) && validMint(coin?.pairMint))
    .sort((a: any, b: any) => Number(b.volume24hUsd || 0) - Number(a.volume24hUsd || 0));
  const selected = new Map<string, any>();
  for (const coin of ranked.slice(0, limit)) selected.set(coin.mint, coin);
  // Crypto-paying launches often begin with no indexed volume. Keep a bounded
  // discovery lane so the general volume ranking cannot hide them.
  for (const coin of ranked.filter((entry: any) => isCryptoPayout(entry.pairMint, entry.pair)).slice(0, cryptoPayoutLimit)) {
    selected.set(coin.mint, coin);
  }
  return [...selected.values()]
    .map((coin: any) => ({
      mint: coin.mint,
      symbol: cleanSymbol(coin.symbol),
      name: String(coin.name || coin.symbol || '').trim().slice(0, 96),
      sourceId: source.id,
      sourceKind: source.kind,
      observedAt: now,
      payout: {
        assets: [{
          mint: coin.pairMint,
          symbol: cleanSymbol(coin.pair),
          category: payoutAssetCategory(coin.pairMint, coin.pair, 'tokenized-asset'),
          issuer: 'x7-declared',
        }],
        completedCycles: 0,
        recordDays: recordDays(coin.createdAt, now),
        receiptsVerified: false,
      },
      protocol: {
        projectScore: coin.rewardsTarget === 'holders' ? 60 : 0,
        firewallPass: false,
      },
      raw: {
        pool: coin.pool || null,
        poolKind: coin.poolKind || null,
        graduated: coin.graduated === true,
        sourceMarket: {
          marketCapUsd: safeNumber(coin.marketCapUsd),
          volume24hUsd: safeNumber(coin.volume24hUsd),
          trades24h: safeNumber(coin.trades24h),
          traders24h: safeNumber(coin.traders24h),
        },
      },
    }));
}

async function loadX7Source(source: any, now: number): Promise<ProductiveSourceSnapshot> {
  const base = new URL(source.baseUrl || 'https://x7pad.com');
  if (base.protocol !== 'https:' || base.hostname !== 'x7pad.com') throw new Error('invalid_x7_base_url');
  const payload = await getJson(new URL('/api/public/coins?limit=100&sort=newest', base).href);
  const candidates = normalizeX7Candidates(payload, source, now);
  const cryptoPayouts = candidates.filter(candidate => candidate.payout.assets.some(asset => isCryptoPayout(asset.mint, asset.symbol))).length;
  return validateProductiveSource({
    schemaVersion: 'pcp-productive-source/v1',
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    status: 'fresh',
    detail: `${candidates.length} x7 holder-directed reward token(s), including ${cryptoPayouts} crypto-payout declaration(s); payout cycles remain unverified`,
    candidates,
  });
}

function trpcResult(payload: any): any {
  if (payload?.error) throw new Error(`memestonks_trpc_${payload.error?.json?.data?.code || 'error'}`);
  const value = payload?.result?.data?.json;
  if (value == null) throw new Error('invalid_memestonks_trpc_payload');
  return value;
}

function memestonksUrl(base: URL, procedure: string, input?: unknown): string {
  const endpoint = new URL(`/api/trpc-pub/${procedure}`, base);
  if (input !== undefined) endpoint.searchParams.set('input', JSON.stringify({ json: input }));
  return endpoint.href;
}

export function normalizeMemestonksCandidate(
  coin: any,
  status: any,
  feeRewards: any,
  source: any,
  now: number,
): ProductiveCandidate | null {
  if (!validMint(coin?.mint) || !validMint(status?.payout?.mint) || status?.enabled !== true) return null;
  const settled = Array.isArray(status.periods)
    ? status.periods.filter((period: any) => period?.status === 'settled' && Number(period?.paidUnits || 0) > 0)
    : [];
  const stream = Array.isArray(feeRewards?.holderStreams)
    ? feeRewards.holderStreams.find((entry: any) => entry?.mint === coin.mint)
    : null;
  const completedCycles = Math.max(settled.length, Number(status.lifetimePeriodsPaid || 0));
  const lastPayoutAt = settled.reduce((latest: number, period: any) => Math.max(latest, Number(period.windowEndMs || 0)), 0) || null;
  return {
    mint: coin.mint,
    symbol: cleanSymbol(coin.symbol),
    name: String(coin.name || coin.symbol || '').trim().slice(0, 96),
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    payout: {
      assets: [{
        mint: status.payout.mint,
        symbol: cleanSymbol(status.payout.symbol || coin.pairSymbol),
        category: payoutAssetCategory(status.payout.mint, status.payout.symbol || coin.pairSymbol, 'tokenized-asset'),
        issuer: 'memestonks-declared',
      }],
      completedCycles,
      recordDays: recordDays(coin.createdAt, now),
      receiptsVerified: completedCycles > 0 && status.allDirect === true && settled.length > 0,
      allRecordedClaimsLanded: status.allDirect === true,
      lastPayoutAt,
    },
    protocol: {
      projectScore: coin.taxFrozen === true && Number(coin.pledgeBps || 0) >= 10000 ? 70 : 50,
      autonomyScore: status.cadence === 'hourly' ? 70 : 50,
      // The public status currently reports pledgeIsOnChain=false. Historical
      // payouts are useful evidence, but admission remains closed on this gate.
      firewallPass: status.pledgeIsOnChain === true,
    },
    raw: {
      cadence: status.cadence || null,
      pledgeBps: Number(status.pledgeBps ?? coin.pledgeBps ?? 0),
      pledgeIsOnChain: status.pledgeIsOnChain === true,
      payoutSummary: stream ? {
        totalUsd: safeNumber(stream.totalUsd),
        payments: safeNumber(stream.payments),
        estimated: stream.estimated === true,
      } : null,
      sourceMarket: {
        marketCapUsd: safeNumber(coin.marketCapUsd),
        volume24hUsd: safeNumber(coin.volume24hUsd),
        txns24h: safeNumber(coin.txns24h),
      },
    },
  };
}

async function loadMemestonksSource(source: any, now: number): Promise<ProductiveSourceSnapshot> {
  const base = new URL(source.baseUrl || 'https://memestonks.ai');
  if (base.protocol !== 'https:' || base.hostname !== 'memestonks.ai') throw new Error('invalid_memestonks_base_url');
  const [boardPayload, feePayload] = await Promise.all([
    getJson(memestonksUrl(base, 'solanaPad.board', { tab: 'trending' })),
    getJson(memestonksUrl(base, 'solanaDividend.feeRewards')),
  ]);
  const board = trpcResult(boardPayload);
  const feeRewards = trpcResult(feePayload);
  if (!Array.isArray(board)) throw new Error('invalid_memestonks_board');
  const limit = Math.max(1, Math.min(50, Number(source.limit || 12)));
  const candidates: ProductiveCandidate[] = [];
  for (const coin of board.slice(0, limit)) {
    if (!validMint(coin?.mint)) continue;
    try {
      const status = trpcResult(await getJson(memestonksUrl(base, 'solanaDividend.status', { token: coin.mint })));
      const candidate = normalizeMemestonksCandidate(coin, status, feeRewards, source, now);
      if (candidate) candidates.push(candidate);
    } catch { /* One malformed token must not suppress the rest of the board. */ }
  }
  return validateProductiveSource({
    schemaVersion: 'pcp-productive-source/v1',
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    status: 'fresh',
    detail: `${candidates.length} MemeStonks token(s) with public dividend status; non-onchain pledge gates remain watch-only`,
    candidates,
  });
}

async function loadVaultBagsSource(source: any, now: number): Promise<ProductiveSourceSnapshot> {
  const base = new URL(source.baseUrl || 'https://vaultbags.app');
  if (base.protocol !== 'https:' || base.hostname !== 'vaultbags.app') throw new Error('invalid_vaultbags_base_url');
  const [projects, payoutIntegrity, rwas] = await Promise.all([
    getJson(new URL('/api/agent/projects', base).href),
    getJson(new URL('/api/agent/payout-integrity', base).href),
    getJson(new URL('/api/agent/rwas', base).href),
  ]);
  if (!Array.isArray(projects?.projects) || !Array.isArray(rwas?.assets)) throw new Error('invalid_vaultbags_registry');
  const assetsBySymbol = new Map(rwas.assets.map((asset: any) => [String(asset.symbol || '').toLowerCase(), asset]));
  const candidates: ProductiveCandidate[] = [];
  for (const project of projects.projects) {
    if (!validMint(project.tokenMint)) continue;
    const mint = project.tokenMint;
    const [treasury, evaluation] = await Promise.all([
      getJson(new URL(`/api/agent/project-treasury?mint=${encodeURIComponent(mint)}`, base).href),
      getJson(new URL(`/api/agent/evaluate?mint=${encodeURIComponent(mint)}`, base).href),
    ]);
    const passport = evaluation?.passport;
    if (treasury?.found !== true || passport?.identity?.tokenMint !== mint) continue;
    const payoutAssets = Object.keys({ ...(treasury.claimPool?.rwa || {}), ...(treasury.lockPool?.rwa || {}) })
      .map(symbol => assetsBySymbol.get(symbol.toLowerCase()))
      .filter(Boolean)
      .map((asset: any) => ({ mint: asset.mint, symbol: asset.symbol, category: asset.category, issuer: asset.issuer?.id }));
    const payoutDimension = (passport.reputation?.dimensions || []).find((dimension: any) => dimension.key === 'payouts');
    candidates.push({
      mint,
      symbol: String(project.ticker || passport.identity?.ticker || '').replace(/^\$/, ''),
      name: String(project.name || passport.identity?.name || ''),
      sourceId: source.id,
      sourceKind: source.kind,
      observedAt: now,
      payout: {
        assets: payoutAssets,
        completedCycles: Number(passport.validation?.cyclesRun || 0),
        recordDays: Number(passport.validation?.ownRecordDays || 0),
        receiptsVerified: payoutIntegrity?.available === true && payoutIntegrity?.allLanded === true && Number(payoutDimension?.score || 0) > 0,
        allRecordedClaimsLanded: payoutIntegrity?.allLanded === true && payoutIntegrity?.checked === payoutIntegrity?.total,
      },
      protocol: {
        projectScore: Number(passport.reputation?.projectScore || 0),
        autonomyScore: Number(passport.reputation?.autonomyScore || 0),
        firewallPass: passport.firewall?.pass === true,
      },
      treasury: {
        valueUsd: Number(treasury.totalValueUsd || 0),
        totalFeesClaimedSol: Number(treasury.totalFeesClaimedSol || 0),
      },
    });
  }
  return validateProductiveSource({
    schemaVersion: 'pcp-productive-source/v1',
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    status: 'fresh',
    detail: `${candidates.length} VaultBags project token(s); connector is one source among the Solana-wide registry`,
    candidates,
  });
}

function loadArtifactSources(source: any, now: number): ProductiveSourceSnapshot[] {
  const directory = path.resolve(ROOT, source.directory || 'artifacts/paper/productive-sources');
  fs.mkdirSync(directory, { recursive: true });
  const snapshots: ProductiveSourceSnapshot[] = [];
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    try {
      const snapshot = validateProductiveSource(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
      snapshots.push({ ...snapshot, status: now - snapshot.observedAt <= 900000 ? snapshot.status : 'stale' });
    } catch { /* Invalid third-party snapshots fail closed and are ignored. */ }
  }
  return snapshots;
}

function loadLaunchpadRegistry(source: any, now: number): ProductiveSourceSnapshot {
  const file = path.resolve(ROOT, source.file || 'config/productive-launchpad-registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (registry?.schemaVersion !== 'pcp-productive-launchpad-registry/v1' || !Array.isArray(registry.launchpads)) {
    throw new Error('invalid_productive_launchpad_registry');
  }
  return {
    schemaVersion: 'pcp-productive-source/v1',
    sourceId: source.id,
    sourceKind: source.kind,
    observedAt: now,
    status: 'fresh',
    detail: `${registry.launchpads.length} launchpad families indexed for discovery; launch venue is not payout proof`,
    candidates: [],
  };
}

function quoteRoute(quote: any, inputMint: string, outputMint: string, inputAmount: string) {
  if (quote?.inputMint !== inputMint || quote?.outputMint !== outputMint || String(quote?.inAmount) !== inputAmount ||
      !/^\d+$/.test(String(quote?.outAmount)) || BigInt(quote.outAmount) <= 0n || !Array.isArray(quote.routePlan) || !quote.routePlan.length) {
    throw new Error('invalid_productive_quote');
  }
  const labels = quote.routePlan.map((leg: any) => String(leg?.swapInfo?.label || 'unknown'));
  if (quote.routePlan.some((leg: any) => !leg?.swapInfo?.ammKey || !leg?.swapInfo?.inputMint || !leg?.swapInfo?.outputMint)) throw new Error('invalid_productive_route');
  return { amount: String(quote.outAmount), labels };
}

export function normalizeGmgnMarket(info: any, mint: string, observedAt: number): ProductiveMarketEvidence {
  if (!info || info.address !== mint) throw new Error('market_mint_conflict');
  const price = safeNumber(info.price?.price);
  const supply = safeNumber(info.circulating_supply);
  const platform = info.fee_distribution?.platform_data;
  const recipients = Array.isArray(platform?.list) ? platform.list : [];
  const numeric = (value: unknown) => safeNumber(value);
  return {
    observedAt,
    mintVerified: false,
    liquidityUsd: numeric(info.liquidity ?? info.pool?.liquidity),
    volume24hUsd: numeric(info.price?.volume_24h),
    holders: numeric(info.holder_count ?? info.stat?.holder_count),
    marketCapUsd: price != null && supply != null ? price * supply : null,
    gmgn: {
      address: info.address,
      symbol: cleanSymbol(info.symbol),
      name: String(info.name || '').trim().slice(0, 128),
      launchpad: info.launchpad ? String(info.launchpad) : null,
      launchpadPlatform: info.launchpad_platform ? String(info.launchpad_platform) : null,
      launchpadStatus: numeric(info.launchpad_status),
      priceUsd: price,
      athPriceUsd: numeric(info.ath_price),
      activity: {
        volume1mUsd: numeric(info.price?.volume_1m),
        volume5mUsd: numeric(info.price?.volume_5m),
        volume1hUsd: numeric(info.price?.volume_1h),
        volume6hUsd: numeric(info.price?.volume_6h),
        volume24hUsd: numeric(info.price?.volume_24h),
        buyVolume24hUsd: numeric(info.price?.buy_volume_24h),
        sellVolume24hUsd: numeric(info.price?.sell_volume_24h),
        buys24h: numeric(info.price?.buys_24h),
        sells24h: numeric(info.price?.sells_24h),
        swaps24h: numeric(info.price?.swaps_24h),
      },
      fees: {
        tradeFee: numeric(info.trade_fee),
        totalFee: numeric(info.total_fee),
        distributionLaunchpad: info.fee_distribution?.launchpad ? String(info.fee_distribution.launchpad) : null,
        bonusCategories: Array.isArray(platform?.bonus_category) ? platform.bonus_category.map(String) : [],
        locked: typeof platform?.is_locked === 'boolean' ? platform.is_locked : null,
        charity: typeof platform?.is_charity === 'boolean' ? platform.is_charity : null,
        recipientCount: recipients.length,
        claimedRecipientCount: recipients.filter((recipient: any) => recipient?.has_claimed_fee === true).length,
      },
      pool: {
        address: info.pool?.pool_address ? String(info.pool.pool_address) : null,
        exchange: info.pool?.exchange ? String(info.pool.exchange) : null,
        quoteMint: validMint(info.pool?.quote_address) ? info.pool.quote_address : null,
        quoteSymbol: info.pool?.quote_symbol ? cleanSymbol(info.pool.quote_symbol) : null,
      },
      holderRisk: {
        top10Rate: numeric(info.stat?.top_10_holder_rate ?? info.dev?.top_10_holder_rate),
        creatorHoldRate: numeric(info.stat?.creator_hold_rate),
        devTeamHoldRate: numeric(info.stat?.dev_team_hold_rate),
        bundlerTraderRate: numeric(info.stat?.top_bundler_trader_percentage),
        botDegenRate: numeric(info.stat?.bot_degen_rate),
        freshWalletRate: numeric(info.stat?.fresh_wallet_rate),
      },
      links: info.link && typeof info.link === 'object' ? info.link : {},
      // Preserve the complete public response for audit and future fields. The
      // normalized values above are the stable dashboard contract.
      providerPayload: { info },
    },
  };
}

async function marketEvidence(providers: any, candidate: ProductiveCandidate): Promise<ProductiveMarketEvidence> {
  const observedAt = Date.now();
  const evidence: ProductiveMarketEvidence = { observedAt, mintVerified: false };
  try {
    const accounts = await providers.accounts([candidate.mint]);
    evidence.decimals = validateMint(accounts.value[0]);
    evidence.mintVerified = true;
  } catch (error: any) {
    evidence.mintIssue = error.message || 'mint_unverified';
  }
  try {
    const info = await providers.call('gmgn', '/v1/token/info', { chain: 'sol', address: candidate.mint });
    Object.assign(evidence, normalizeGmgnMarket(info, candidate.mint, observedAt), {
      mintVerified: evidence.mintVerified,
      mintIssue: evidence.mintIssue,
      decimals: evidence.decimals,
    });
  } catch (error: any) {
    evidence.issue = error.message || 'market_metadata_unavailable';
  }
  try {
    const inputAmount = String(QUOTE_LAMPORTS);
    const buy = quoteRoute(await providers.call('jupiter', '/swap/v1/quote', {
      inputMint: SOL, outputMint: candidate.mint, amount: inputAmount, swapMode: 'ExactIn', slippageBps: 100,
    }), SOL, candidate.mint, inputAmount);
    const sell = quoteRoute(await providers.call('jupiter', '/swap/v1/quote', {
      inputMint: candidate.mint, outputMint: SOL, amount: buy.amount, swapMode: 'ExactIn', slippageBps: 100,
    }), candidate.mint, SOL, buy.amount);
    evidence.roundTripLossPct = Math.max(0, 1 - Number(BigInt(sell.amount)) / QUOTE_LAMPORTS);
    evidence.buyRoute = buy.labels;
    evidence.sellRoute = sell.labels;
  } catch (error: any) {
    evidence.issue = [evidence.issue, error.message || 'round_trip_quote_unavailable'].filter(Boolean).join(';');
  }
  return evidence;
}

function appendEvent(snapshot: any) {
  const event = {
    id: `${snapshot.generatedAt}:${snapshot.coverage.candidates}:${snapshot.coverage.eligible}`,
    ts: snapshot.generatedAt,
    type: 'productive_treasury_snapshot',
    coverage: snapshot.coverage,
    decisions: snapshot.candidates.map((candidate: any) => ({ mint: candidate.mint, sourceId: candidate.sourceId, decision: candidate.decision, issues: candidate.issues })),
  };
  fs.appendFileSync(EVENT_FILE, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function runCycle(config: any, providers: any) {
  const now = Date.now();
  const loadSource = async (source: any): Promise<ProductiveSourceSnapshot[]> => {
    if (['vaultbags', 'otc', 'x7', 'memestonks'].includes(source.kind)) {
      try {
        if (source.kind === 'vaultbags') return [await loadVaultBagsSource(source, now)];
        if (source.kind === 'otc') return [await loadOtcSource(source, now)];
        if (source.kind === 'x7') return [await loadX7Source(source, now)];
        return [await loadMemestonksSource(source, now)];
      }
      catch (error: any) {
        return [{ schemaVersion: 'pcp-productive-source/v1', sourceId: source.id, sourceKind: source.kind, observedAt: now, status: 'error', detail: error.message, candidates: [] }];
      }
    }
    if (source.kind === 'artifact-directory') return loadArtifactSources(source, now);
    if (source.kind === 'registry') {
      try { return [loadLaunchpadRegistry(source, now)]; }
      catch (error: any) {
        return [{ schemaVersion: 'pcp-productive-source/v1', sourceId: source.id, sourceKind: source.kind, observedAt: now, status: 'error', detail: error.message, candidates: [] }];
      }
    }
    return [];
  };
  const enabled = config.sources.filter((source: any) => source.enabled === true);
  const sources: ProductiveSourceSnapshot[] = (await mapWithConcurrency(enabled, 4, loadSource)).flat();
  const unique = new Map<string, ProductiveCandidate>();
  for (const source of sources) for (const candidate of source.candidates) if (!unique.has(candidate.mint)) unique.set(candidate.mint, candidate);
  const candidates = [...unique.values()];
  const evidence = await mapWithConcurrency(candidates, 4, candidate => marketEvidence(providers, candidate));
  const marketsByMint: Record<string, ProductiveMarketEvidence> = {};
  candidates.forEach((candidate, index) => { marketsByMint[candidate.mint] = evidence[index]; });
  const snapshot = buildProductiveTreasurySnapshot({ sources, marketsByMint, policy: config.policy as ProductivePolicy, generatedAt: Date.now() });
  atomic(STATE_FILE, snapshot);
  appendEvent(snapshot);
  return snapshot;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const lock = fs.openSync(LOCK_FILE, 'wx', 0o600);
  fs.writeFileSync(lock, String(process.pid));
  let stop = false;
  const stopHandler = () => { stop = true; };
  process.on('SIGTERM', stopHandler);
  process.on('SIGINT', stopHandler);
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (config?.schemaVersion !== 'pcp-productive-source-config/v1' || !Array.isArray(config.sources)) throw new Error('invalid_productive_config');
    const providers = new Providers(DIR, { usageFile: path.join(DIR, 'productive-provider-usage.json') });
    do {
      const snapshot = await runCycle(config, providers);
      console.log(JSON.stringify({ generatedAt: snapshot.generatedAt, coverage: snapshot.coverage, execution: snapshot.execution }));
      if (process.argv.includes('--once')) break;
      // Check for a stop signal every second so SIGTERM does not wait out the
      // full poll interval (previously up to five minutes) before exiting.
      const deadline = Date.now() + POLL_MS;
      while (!stop && Date.now() < deadline) await sleep(1000);
    } while (!stop);
  } finally {
    fs.closeSync(lock);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* Already removed. */ }
  }
}

export { loadArtifactSources, loadMemestonksSource, loadOtcSource, loadVaultBagsSource, loadX7Source, marketEvidence, runCycle };
if (require.main === module) main().catch(error => { console.error(`[PRODUCTIVE-TREASURY] ${error.message}`); process.exitCode = 1; });
