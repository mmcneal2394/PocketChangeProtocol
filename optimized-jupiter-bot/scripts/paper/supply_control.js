'use strict';
const fs = require('fs');
const path = require('path');
const { TOKEN } = require('./live_providers');

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
const PROFILE_FILE = path.resolve(__dirname, '../../config/paper-supply-control-profiles.json');

function ratio(raw, total) {
  if (total <= 0n || raw < 0n) return null;
  return Number((raw * 1000000000000n) / total) / 1000000000000;
}

function profiles() {
  const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  if (parsed?.schemaVersion !== 'pcp-paper-supply-control-profiles/v1' || !Array.isArray(parsed.profiles)) throw new Error('invalid_supply_control_profiles');
  return parsed.profiles;
}

function getSupplyControlProfile(mint, now = Date.now()) {
  const profile = profiles().find(row => row.mint === mint) || null;
  if (!profile) return null;
  const expiresAt = Date.parse(profile.expiresAt);
  return { ...profile, active: Number.isFinite(expiresAt) && expiresAt >= now };
}

function deriveSupplyControl(evidence, helius, tokenAccounts, authorityAccounts, observedAt, previous = null) {
  const largest = helius?.largestAccounts?.slice(0, 10);
  if (!Array.isArray(largest) || !largest.length || !/^\d+$/.test(String(helius?.supply?.rawAmount))) throw new Error('invalid_supply_control_largest_accounts');
  if (!Array.isArray(tokenAccounts?.value) || tokenAccounts.value.length !== largest.length) throw new Error('invalid_supply_control_token_accounts');
  const authorities = tokenAccounts.value.map(account => account?.data?.parsed?.info?.owner);
  const uniqueAuthorities = [...new Set(authorities.filter(value => typeof value === 'string' && value))];
  if (!Array.isArray(authorityAccounts?.value) || authorityAccounts.value.length !== uniqueAuthorities.length) throw new Error('invalid_supply_control_authorities');
  const authorityByAddress = new Map(uniqueAuthorities.map((address, index) => [address, authorityAccounts.value[index]]));
  const profile = getSupplyControlProfile(evidence.mint, observedAt);
  const controllerByAuthority = new Map((profile?.controllers || []).map(row => [row.authority, row]));
  const total = BigInt(helius.supply.rawAmount);
  const rows = largest.map((row, index) => {
    const account = tokenAccounts.value[index];
    const parsed = account?.data?.parsed;
    if (![TOKEN, TOKEN_2022].includes(account?.owner) || parsed?.type !== 'account' || parsed.info?.mint !== evidence.mint ||
        parsed.info?.state !== 'initialized' || !/^\d+$/.test(String(parsed.info?.tokenAmount?.amount)) || String(parsed.info.tokenAmount.amount) !== row.rawAmount) {
      throw new Error('supply_control_token_account_conflict');
    }
    const authority = parsed.info.owner;
    const authorityAccount = authorityByAddress.get(authority);
    if (!authorityAccount || typeof authorityAccount.owner !== 'string') throw new Error('supply_control_authority_missing');
    const controller = controllerByAuthority.get(authority);
    let category = 'unattributed_wallet';
    let label = 'Unattributed holder authority';
    let identityConfidence = 'unattributed';
    if (row.address === evidence.poolDescription?.base_vault_address && authority === evidence.pool) {
      category = 'verified_liquidity_pool'; label = 'Verified active-pool base vault'; identityConfidence = 'onchain_verified';
    } else if (controller) {
      category = controller.category; label = controller.label; identityConfidence = controller.identityConfidence;
    } else if (authorityAccount.owner !== SYSTEM) {
      category = 'unattributed_program_custody'; label = 'Unattributed program-controlled authority'; identityConfidence = 'program_owner_only';
    }
    return {
      rank: index + 1, tokenAccount: row.address, authority, rawAmount: row.rawAmount,
      ratio: ratio(BigInt(row.rawAmount), total), tokenProgram: account.owner,
      authorityProgram: authorityAccount.owner, authorityExecutable: authorityAccount.executable === true,
      category, label, identityConfidence,
    };
  });
  const sum = predicate => rows.filter(predicate).reduce((totalRatio, row) => totalRatio + row.ratio, 0);
  const monitored = row => row.category.startsWith('reviewed_') || row.category === 'known_market_maker';
  const unattributed = row => row.category.startsWith('unattributed_');
  const monitoredControllerRatio = sum(monitored);
  const previousRatio = Number(previous?.monitoredControllerRatio);
  const movement = Number.isFinite(previousRatio) ? monitoredControllerRatio - previousRatio : null;
  const presentAuthorities = new Set(rows.map(row => row.authority));
  const missingRequiredControllers = (profile?.controllers || []).filter(row => !presentAuthorities.has(row.authority)).map(row => row.authority);
  return {
    schemaVersion: 'pcp-paper-supply-control/v1', observedAt, slot: tokenAccounts.context?.slot || null,
    profile: profile ? { id: profile.id, active: profile.active, reviewedAt: profile.reviewedAt, expiresAt: profile.expiresAt, basis: profile.basis, sources: profile.sources, admission: profile.admission } : null,
    rawTop10Ratio: helius.top10AccountRatio,
    monitoredControllerRatio,
    verifiedLiquidityPoolRatio: sum(row => row.category === 'verified_liquidity_pool'),
    knownMarketMakerRatio: sum(row => row.category === 'known_market_maker'),
    unattributedTop10Ratio: sum(unattributed),
    maxSingleUnattributedRatio: Math.max(0, ...rows.filter(unattributed).map(row => row.ratio)),
    controllerMovementSincePreviousRatio: movement,
    missingRequiredControllers,
    accountVerification: 'confirmed_rpc', rows,
    interpretation: 'Raw concentration is separated into verified pool custody, reviewed controllers, known market makers, and unattributed authority risk. Reviewed custody is monitored, not assumed harmless.',
  };
}

function concentrationIssues(evidence, defaultMaxTop10 = 0.30) {
  const raw = Number(evidence?.concentration?.top10);
  if (!Number.isFinite(raw) || raw < 0) return ['quality_holder_concentration'];
  if (raw <= defaultMaxTop10) return [];
  const control = evidence.supplyControl;
  const profile = control?.profile;
  const admission = profile?.admission;
  if (!profile || !profile.active || !admission || control.accountVerification !== 'confirmed_rpc') return ['quality_holder_concentration'];
  const issues = [];
  if (control.missingRequiredControllers?.length) issues.push('supply_control_controller_missing');
  if (raw > admission.maxRawTop10Ratio) issues.push('supply_control_raw_top10_above_profile');
  if (control.monitoredControllerRatio < admission.minMonitoredControllerRatio) issues.push('supply_control_controller_ratio_below_profile');
  if (control.unattributedTop10Ratio > admission.maxUnattributedTop10Ratio) issues.push('supply_control_unattributed_top10_above_profile');
  if (control.maxSingleUnattributedRatio > admission.maxSingleUnattributedRatio) issues.push('supply_control_unattributed_holder_above_profile');
  const movement = control.controllerMovementSincePreviousRatio;
  if (Number.isFinite(movement) && movement < -admission.maxControllerOutflowPerObservationRatio) issues.push('supply_control_controller_outflow');
  if (Number(evidence.liquidityUsd) < admission.minLiquidityUsd) issues.push('supply_control_liquidity_below_profile');
  if (Number(evidence.holderCount) < admission.minHolders) issues.push('supply_control_holders_below_profile');
  if (Number(evidence.flow?.windows?.['24h']?.volumeUsd) < admission.minVolume24hUsd) issues.push('supply_control_volume24h_below_profile');
  return issues;
}

module.exports = { PROFILE_FILE, getSupplyControlProfile, deriveSupplyControl, concentrationIssues };
