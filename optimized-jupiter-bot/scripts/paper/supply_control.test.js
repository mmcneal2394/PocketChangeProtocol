const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TOKEN } = require('./live_providers');
const { deriveSupplyControl, concentrationIssues } = require('./supply_control');

const mint = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
const pool = 'FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC';
const controllers = ['7oU9nR9VEvFPwvp2PpXo2LQc6A92QRhcUTwhLWT7MsDM', 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52'];
function tokenAccount(authority, amount) {
  return { owner: TOKEN, executable: false, data: { parsed: { type: 'account', info: { mint, owner: authority, state: 'initialized', tokenAmount: { amount, decimals: 6 } } } } };
}
function fixture() {
  const amounts = ['490000000', '90000000', '25000000', '20000000', '15000000', '20000000'];
  const addresses = ['controller-a', 'controller-b', 'unknown-a', 'unknown-b', 'unknown-c', 'pool-vault'];
  const authorities = [...controllers, 'unknown-wallet-a', 'unknown-wallet-b', 'unknown-wallet-c', pool];
  const helius = { supply: { rawAmount: '1000000000' }, top10AccountRatio: 0.66,
    largestAccounts: addresses.map((address, index) => ({ address, rawAmount: amounts[index] })) };
  const evidence = { mint, pool, poolDescription: { base_vault_address: 'pool-vault' }, concentration: { top10: 0.66 },
    liquidityUsd: 2000000, holderCount: 140000, flow: { windows: { '24h': { volumeUsd: 5000000 } } } };
  const tokenAccounts = { context: { slot: 10 }, value: authorities.map((authority, index) => tokenAccount(authority, amounts[index])) };
  const authorityAccounts = { value: authorities.map(authority => ({ owner: authority === pool ? 'pool-program' : '11111111111111111111111111111111', executable: false })) };
  return { evidence, helius, tokenAccounts, authorityAccounts };
}

test('reviewed supply controllers are separated from pool and unattributed concentration', () => {
  const f = fixture();
  f.evidence.supplyControl = deriveSupplyControl(f.evidence, f.helius, f.tokenAccounts, f.authorityAccounts, Date.parse('2026-09-30T00:00:00Z'));
  assert.equal(f.evidence.supplyControl.monitoredControllerRatio, 0.58);
  assert.equal(f.evidence.supplyControl.unattributedTop10Ratio, 0.06);
  assert.equal(f.evidence.supplyControl.verifiedLiquidityPoolRatio, 0.02);
  assert.deepEqual(concentrationIssues(f.evidence), []);
});

test('profile does not waive excess unknown supply, missing controller, depth, or outflow', () => {
  const f = fixture();
  f.evidence.supplyControl = deriveSupplyControl(f.evidence, f.helius, f.tokenAccounts, f.authorityAccounts, Date.parse('2026-09-30T00:00:00Z'), { monitoredControllerRatio: 0.61 });
  assert.ok(concentrationIssues(f.evidence).includes('supply_control_controller_outflow'));
  f.evidence.supplyControl.unattributedTop10Ratio = 0.20;
  assert.ok(concentrationIssues(f.evidence).includes('supply_control_unattributed_top10_above_profile'));
  f.evidence.liquidityUsd = 100;
  assert.ok(concentrationIssues(f.evidence).includes('supply_control_liquidity_below_profile'));
});
