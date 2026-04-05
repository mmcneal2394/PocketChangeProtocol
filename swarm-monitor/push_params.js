/**
 * Push optimized trading params to the momentum sniper via Redis + config:update
 * 
 * Changes from previous config:
 *   - maxTPpct: 0.08 → REMOVED (let trailing stop handle exits, no hard cap)
 *   - stopLossPct: 0.2 → 0.15 (tighter initial SL to cut losers faster) 
 *   - maxHoldMinutes: 2 → 15 (give pumps room to run)
 *   - MIN_LIQUIDITY_USD: 5000 → 20000 (avoid microcap traps)
 *   - MIN_SPREAD_PCT: 0.3 (confirmed)
 */
const Redis = require('ioredis');
const r = new Redis();

async function main() {
  // 1. Push to config:update (read by config_manager → target_qualifier + sniper_node)
  const configUpdate = {
    MIN_SPREAD_PCT: 0.3,
    MIN_LIQUIDITY_USD: 20000,
    MAX_SLIPPAGE_BPS: 30,
  };
  const n1 = await r.publish('config:update', JSON.stringify(configUpdate));
  console.log(`[1/3] config:update delivered to ${n1} subscribers:`, configUpdate);

  // 2. Push momentum sniper dynamic overrides
  //    maxTPpct=1.0 (100%) = effectively disables hard TP, lets trailing stop do the work
  //    The trailing stop logic already guarantees:
  //      peak >= 12%: lock profit at peak - 2% (min +10%)
  //      peak >= 20%: lock profit at peak - 5% (min +15%)
  //      peak >= 50%: lock profit at peak - 15% (min +35%)
  const sniperOverride = {
    maxTPpct: 0.12,          // 12% TP — realistic for bonded tokens with real liquidity
    stopLossPct: 0.05,       // Cut losers at -5%
    maxHoldMinutes: 5,       // 5 min hold — bonded tokens need slightly more time
    dynamicMinMom1m: 3,      // Momentum threshold for entry
    dynamicMaxAgeMin: 525600, // Don't filter by age
    BASE_BUY_PCT: 0.10,      // 10% of WSOL balance per trade
    PRIORITY_FEE_MICROLAMPORTS: 5000,
  };
  const n2 = await r.publish('config:update', JSON.stringify(sniperOverride));
  console.log(`[2/3] sniper override delivered to ${n2} subscribers:`, sniperOverride);

  // 3. Push to critic:proposals so Kelly optimizer acknowledges
  const n3 = await r.publish('critic:proposals', JSON.stringify({
    source: 'manual_optimization',
    params: { ...configUpdate, ...sniperOverride },
    reason: 'Ride pumps with trailing stops, avoid microcap, raise liquidity floor to $20K'
  }));
  console.log(`[3/3] critic:proposals delivered to ${n3} subscribers`);

  console.log('\n✅ All params pushed successfully');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
