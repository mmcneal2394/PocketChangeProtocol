'use strict';
const { SOL, TOKEN } = require('./live_providers');
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function number(v) { return v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v); }
function ratio(v) { const n = number(v); return n !== null && n >= 0 && n <= 1 ? n : null; }
function snapshot(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
function windowFlow(price, suffix) {
  return {
    priceUsd: number(price[`price_${suffix}`]), buys: number(price[`buys_${suffix}`]), sells: number(price[`sells_${suffix}`]),
    swaps: number(price[`swaps_${suffix}`]), volumeUsd: number(price[`volume_${suffix}`]),
    buyVolumeUsd: number(price[`buy_volume_${suffix}`]), sellVolumeUsd: number(price[`sell_volume_${suffix}`]),
  };
}
function deriveChecks(e) {
  const result = {};
  const check = (name, known, pass, detail) => { result[name] = { status: !known ? 'unknown' : pass ? 'pass' : 'warn', detail }; };
  check('tokenControls', true, e.security.mintRenounced && e.security.freezeRenounced, 'Mint and freeze authorities renounced');
  check('providerAlert', true, !e.security.alert && !e.security.flags?.length, 'No GMGN alert or flags');
  check('poolIdentity', true, e.pool === e.poolDescription.pool_address && e.mint === e.poolDescription.base_address, 'Token and pool identities agree');
  check('positiveLiquidity', e.liquidityUsd !== null, e.liquidityUsd > 0, 'Positive reported pool liquidity');
  const concentrationAccepted = e.concentration.top10 <= 0.30 || (e.supplyControl?.profile?.active === true && require('./supply_control').concentrationIssues(e).length === 0);
  check('holderConcentration', e.concentration.top10 !== null, concentrationAccepted, 'Top-10 ownership at or below 30%, or a current reviewed supply-control profile passes stricter monitoring');
  const supply = e.supply;
  check('supplyIntegrity', [supply.circulating, supply.total, supply.max].every(v => v !== null), supply.circulating <= supply.total && supply.total <= supply.max, 'Circulating <= total <= max supply');
  const one = e.flow.windows['1m'];
  check('flowArithmetic', [one.buys, one.sells, one.swaps].every(v => v !== null), one.buys + one.sells === one.swaps, 'Buys + sells equals swaps');
  check('volumeArithmetic', [one.buyVolumeUsd, one.sellVolumeUsd, one.volumeUsd].every(v => v !== null), Math.abs(one.buyVolumeUsd + one.sellVolumeUsd - one.volumeUsd) <= Math.max(0.01, one.volumeUsd * 0.01), 'Buy + sell volume agrees with total');
  check('taxes', [e.security.buyTax, e.security.sellTax].every(v => v !== null), e.security.buyTax === 0 && e.security.sellTax === 0, 'No reported transfer taxes');
  check('burnStatus', e.security.burnRatio !== null, e.security.burnRatio > 0, 'Provider reports burned supply or liquidity');
  check('socialPresence', true, Object.values(e.socials).some(value => typeof value === 'string' && value.length > 0), 'At least one public project link');
  check('migrationIdentity', Number(e.migration.status) === 1, e.migration.migratedPool === e.pool, 'Migrated pool matches active pool');
  const reinforced = e.reinforcement;
  check('onchainSupply', Boolean(reinforced?.supply), Boolean(reinforced?.supply) && reinforced.supply.total >= 0, 'Supply independently read from Solana RPC');
  check('onchainConcentration', reinforced?.top10AccountRatio !== null && reinforced?.top10AccountRatio !== undefined,
    reinforced?.top10AccountRatio >= 0 && reinforced?.top10AccountRatio <= 0.30, 'Largest-account concentration independently read from Solana RPC; includes pool and program accounts');
  check('supplyControlAttribution', e.concentration.top10 <= 0.30 || Boolean(e.supplyControl),
    e.concentration.top10 <= 0.30 || e.supplyControl?.accountVerification === 'confirmed_rpc', 'High concentration is attributed through confirmed token-account authorities');
  const supplyDifference = reinforced?.comparison?.supplyDifferenceRatio;
  check('supplyAgreement', supplyDifference !== null && supplyDifference !== undefined, supplyDifference <= 0.001, 'GMGN and Solana RPC supply agree within 0.1%');
  return result;
}
function normalize(mint, info, security, pool, observedAt) {
  if ([info, security, pool].some(r => r?.address !== mint)) throw new Error('discovery_mint_conflict');
  if (!pool.pool_address || info.biggest_pool_address !== pool.pool_address || pool.base_address !== mint) throw new Error('discovery_pool_conflict');
  const created = number(info.creation_timestamp);
  if (!created || created * 1000 > observedAt) throw new Error('unknown_launch_age');
  const stat = info.stat || {}, price = info.price || {};
  const flowWindows = Object.fromEntries(['1m', '5m', '1h', '6h', '24h'].map(window => [window, windowFlow(price, window)]));
  const evidence = {
    mint, observedAt, source: 'gmgn', createdAt: created * 1000, ageSeconds: Math.floor(observedAt / 1000 - created),
    identity: { name: info.name || null, symbol: info.symbol || null, decimals: number(info.decimals), standard: info.standard || null },
    pool: pool.pool_address, poolQuoteMint: pool.quote_address, exchange: pool.exchange,
    liquidityUsd: number(pool.liquidity), holderCount: number(info.holder_count),
    supply: { circulating: number(info.circulating_supply), total: number(info.total_supply), max: number(info.max_supply), lockedRatio: ratio(info.locked_ratio) },
    concentration: { top10: ratio(security.top_10_holder_rate), creator: ratio(stat.creator_hold_rate), devTeam: ratio(stat.dev_team_hold_rate), sniper: ratio(stat.top70_sniper_hold_rate), bundler: ratio(stat.top_bundler_trader_percentage), insider: ratio(stat.top_rat_trader_percentage), entrapment: ratio(stat.top_entrapment_trader_percentage), botDegen: ratio(stat.top_bot_degen_percentage), privateVault: ratio(stat.private_vault_hold_rate), freshWallet: ratio(stat.fresh_wallet_rate) },
    creator: { address: info.dev?.creator_address || null, tokenBalance: number(info.dev?.creator_token_balance), status: info.dev?.creator_token_status || null, createdCount: number(stat.creator_created_count), openCount: number(info.dev?.creator_open_count), fundingSource: info.dev?.fund_from || null, fundedAt: number(info.dev?.fund_from_ts), offchain: info.dev?.offchain === true, twitterNameHistory: info.dev?.twitter_name_change_history || [], deletedPostTokenCount: number(info.dev?.twitter_del_post_token_count), twitterTokenCount: number(info.dev?.twitter_create_token_count), athToken: info.dev?.ath_token_info || null },
    creatorStatus: info.dev?.creator_token_status || null,
    media: { image: info.logo || null, banner: info.banner || null, providerOg: info.og === true, duplicateCount: number(info.image_dup_count) },
    socials: { website: info.link?.website || null, twitter: info.link?.twitter_username || null, telegram: info.link?.telegram || null, discord: info.link?.discord || null, github: info.link?.github || null, instagram: info.link?.instagram || null, reddit: info.link?.reddit || null, tiktok: info.link?.tiktok || null, youtube: info.link?.youtube || null, medium: info.link?.medium || null, facebook: info.link?.facebook || null, linkedin: info.link?.linkedin || null, bitbucket: info.link?.bitbucket || null, farcaster: info.link?.fracaster || null, description: info.link?.description || null, gmgn: info.link?.gmgn || null, geckoterminal: info.link?.geckoterminal || null, verified: Number(info.link?.verify_status) === 1 },
    flow: { buys1m: flowWindows['1m'].buys, sells1m: flowWindows['1m'].sells, swaps1m: flowWindows['1m'].swaps, volume1mUsd: flowWindows['1m'].volumeUsd, volume5mUsd: flowWindows['5m'].volumeUsd, hotLevel: number(price.hot_level), windows: flowWindows },
    attention: { visits: number(info.visiting_count), signalCount: number(stat.signal_count), degenCallCount: number(stat.degen_call_count), dexAd: number(info.dev?.dexscr_ad), dexUpdateLink: number(info.dev?.dexscr_update_link), cto: number(info.dev?.cto_flag), boostFee: number(info.dev?.dexscr_boost_fee), trendingBar: number(info.dev?.dexscr_trending_bar) },
    walletTags: snapshot(info.wallet_tags_stat || {}),
    fees: { trade: number(info.trade_fee), total: number(info.total_fee), poolRatio: number(pool.fee_ratio) },
    security: { mintRenounced: security.renounced_mint === true, freezeRenounced: security.renounced_freeze_account === true, alert: security.is_show_alert === true, flags: Array.isArray(security.flags) ? security.flags : null, honeypot: 'not_applicable_to_solana', burnRatio: ratio(security.burn_ratio), burnStatus: security.burn_status || null, buyTax: number(security.buy_tax), sellTax: number(security.sell_tax), averageTax: number(security.average_tax), highTax: number(security.high_tax), blacklist: security.is_blacklist ?? security.blacklist ?? null, openSource: security.is_open_source ?? security.open_source ?? null, canSell: security.can_sell ?? null, cannotSell: security.can_not_sell ?? null, lockSummary: snapshot(security.lock_summary), lockInfo: snapshot(security.lockInfo), privileges: snapshot(security.privileges), hideRisk: security.hide_risk === true },
    migration: { status: info.launchpad_status, migratedPool: info.migrated_pool || null, platform: info.launchpad_platform || null, launchpad: info.launchpad || null, progress: number(info.launchpad_progress), openedAt: number(info.open_timestamp), migratedAt: number(info.migrated_timestamp), marketCap: number(info.migration_market_cap), marketCapQuote: info.migration_market_cap_quote || null },
    poolDescription: pool,
    providerPayload: { info: snapshot(info), security: snapshot(security), pool: snapshot(pool) },
  };
  evidence.checks = deriveChecks(evidence);
  return evidence;
}
function admissionIssues(e, now) {
  const issues = [];
  if (!e || e.observedAt > now || now - e.observedAt > 30000) return ['stale_discovery_evidence'];
  if (!(e.liquidityUsd > 0)) issues.push('missing_positive_liquidity');
  if (!(e.holderCount > 0)) issues.push('missing_holder_count');
  if (e.concentration.top10 === null) issues.push('missing_concentration');
  if (!e.security.mintRenounced || !e.security.freezeRenounced) issues.push('unverified_token_controls');
  if (e.security.alert || e.security.flags?.length) issues.push('provider_security_alert');
  if (e.security.flags === null) issues.push('missing_security_flags');
  if ([e.flow.buys1m, e.flow.sells1m, e.flow.swaps1m, e.flow.volume1mUsd].some(n => n === null || n < 0)) issues.push('missing_recent_flow');
  return issues;
}
function tokenBalance(account, mint) {
  const parsed = account?.data?.parsed;
  if (![TOKEN, TOKEN2022].includes(account?.owner) || parsed?.type !== 'account' || parsed.info?.mint !== mint || parsed.info?.state !== 'initialized') throw new Error('vault_mint_or_state_conflict');
  const t = parsed.info.tokenAmount;
  if (!/^\d+$/.test(String(t?.amount)) || !Number.isInteger(t?.decimals)) throw new Error('invalid_vault_balance');
  const amount = Number(t.amount) / 10 ** t.decimals;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('empty_pool_reserves');
  return { amount, authority: parsed.info.owner };
}
function reserveEvidence(e, accounts, now) {
  const p = e.poolDescription;
  if (p.quote_address !== SOL) throw new Error('unsupported_pool_quote_currency');
  const [pool, base, quote] = accounts.value;
  if (!pool || pool.executable || [TOKEN, TOKEN2022, '11111111111111111111111111111111'].includes(pool.owner)) throw new Error('invalid_pool_owner');
  const b = tokenBalance(base, e.mint), q = tokenBalance(quote, SOL);
  if (!b.authority || b.authority !== q.authority) throw new Error('vault_authority_conflict');
  const rpcProvider = accounts.rpcProvider || 'unknown_rpc';
  return { observedAt: now, slot: accounts.context.slot, source: `${rpcProvider}_confirmed_vault_balances`, rpcProvider, pool: e.pool, poolOwner: pool.owner, baseTokens: b.amount, quoteSol: q.amount, reserveRatioSol: q.amount / b.amount, interpretation: 'reserve ratio, not executable price or trade OHLC', poolLayoutDecoded: false };
}
function updateTraffic(previous, flow, now) {
  const values = [flow.buys1m, flow.sells1m, flow.swaps1m, flow.volume1mUsd];
  if (values.some(n => n === null || !Number.isFinite(n) || n < 0)) return { checkedAt: now, quietSince: null, source: 'gmgn_rolling_1m' };
  if (values.some(n => n > 0)) return { checkedAt: now, quietSince: null, source: 'gmgn_rolling_1m' };
  const covered = previous?.quietSince != null && previous.checkedAt <= now && now - previous.checkedAt <= 60000;
  return { checkedAt: now, quietSince: covered ? previous.quietSince : now - 60000, source: 'gmgn_rolling_1m' };
}
module.exports = { normalize, admissionIssues, reserveEvidence, updateTraffic, deriveChecks };
