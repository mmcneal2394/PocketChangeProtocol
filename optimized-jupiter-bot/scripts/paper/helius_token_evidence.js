'use strict';

function ratio(numerator, denominator) {
  if (denominator <= 0n || numerator < 0n) return null;
  return Number((numerator * 1000000000000n) / denominator) / 1000000000000;
}

function normalizeHeliusTokenEvidence(mint, supplyResponse, largestResponse, observedAt) {
  const supply = supplyResponse?.value;
  if (!/^\d+$/.test(String(supply?.amount)) || !Number.isInteger(supply?.decimals)) throw new Error('invalid_helius_supply');
  if (!Array.isArray(largestResponse?.value)) throw new Error('invalid_helius_largest_accounts');
  const rawSupply = BigInt(supply.amount);
  const accounts = largestResponse.value.map(row => {
    if (typeof row?.address !== 'string' || !/^\d+$/.test(String(row.amount))) throw new Error('invalid_helius_largest_account');
    return { address: row.address, rawAmount: String(row.amount) };
  });
  const top10Raw = accounts.slice(0, 10).reduce((sum, row) => sum + BigInt(row.rawAmount), 0n);
  const total = Number(supply.amount) / 10 ** supply.decimals;
  if (!Number.isFinite(total) || total < 0) throw new Error('invalid_helius_supply');
  return {
    source: supplyResponse.rpcProvider === 'helius' && largestResponse.rpcProvider === 'helius' ? 'helius_rpc' : 'rpc_failover',
    providers: [...new Set([supplyResponse.rpcProvider, largestResponse.rpcProvider].filter(Boolean))],
    observedAt,
    mint,
    slots: { supply: supplyResponse.context.slot, largestAccounts: largestResponse.context.slot },
    supply: { rawAmount: String(supply.amount), decimals: supply.decimals, total },
    largestAccounts: accounts,
    top10AccountRatio: ratio(top10Raw, rawSupply),
    interpretation: 'On-chain token supply and largest token accounts; account concentration is not beneficial-owner concentration.',
  };
}

function reinforceDiscoveryEvidence(evidence, helius) {
  const gmgnSupply = evidence.supply.total;
  const gmgnTop10 = evidence.concentration.top10;
  evidence.reinforcement = helius;
  evidence.supply.totalSource = evidence.supply.total === null ? helius.source : 'gmgn';
  if (evidence.supply.total === null) evidence.supply.total = helius.supply.total;
  evidence.concentration.top10Source = evidence.concentration.top10 === null ? `${helius.source}_largest_accounts` : 'gmgn';
  if (evidence.concentration.top10 === null) evidence.concentration.top10 = helius.top10AccountRatio;
  evidence.reinforcement.comparison = {
    gmgnSupply,
    supplyDifferenceRatio: gmgnSupply === null || gmgnSupply === 0 ? null : Math.abs(helius.supply.total - gmgnSupply) / gmgnSupply,
    gmgnBeneficialOwnerTop10: gmgnTop10,
    heliusLargestAccountTop10: helius.top10AccountRatio,
    concentrationScopesComparable: false,
  };
  return evidence;
}

module.exports = { normalizeHeliusTokenEvidence, reinforceDiscoveryEvidence };
