'use strict';
function exitRisk(state, now = Date.now()) {
  let freshValue = 0, unresolvedCost = 0, unresolved = 0;
  for (const p of state.positions.filter(p => p.closedAt === null)) {
    const m = state.marksByMint[p.mint];
    const q = m?.exitQuotes?.find(q => Math.abs(q.tokenAmount - p.remainingTokenAmount) <= Math.max(1e-10, p.remainingTokenAmount * 1e-9));
    if (m?.fresh && now >= m.updatedAt && now - m.updatedAt <= 30000 && q && Number.isFinite(q.proceedsSol) && q.proceedsSol > 0) freshValue += q.proceedsSol * (1 - state.config.modeledFeeBps / 10000);
    else { unresolved++; unresolvedCost += p.originalCapitalSol * p.remainingTokenAmount / p.originalTokenAmount; }
  }
  const funding = state.config.startingCapitalSol + (state.capitalAdjustments || []).reduce((a, x) => a + x.amountSol, 0);
  const stressEquity = state.availableCapitalSol + freshValue;
  return { unresolved, unresolvedCost, stressEquity, stressPnl: stressEquity - funding, funding };
}
module.exports = { exitRisk };
