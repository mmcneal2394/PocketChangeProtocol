'use strict';
const { SOL } = require('./live_providers');
async function exitQuote(providers, mint, amount, verifyPool, record = () => {}) {
  const failures = [];
  for (const source of ['bags', 'jupiter']) {
    const startedAt = Date.now();
    try {
      const quote = await (source === 'bags' ? providers.quote(mint, SOL, amount) : providers.jupiterQuote(mint, SOL, amount));
      const pool = quote.routePlan[0].marketKey;
      const owner = await verifyPool(pool, quote.contextSlot);
      if (Date.now() - startedAt > 30000) throw new Error('exit_quote_expired');
      record({ source, at: Date.now(), amount, pool, owner, slot: quote.contextSlot, outAmount: quote.outAmount, status: 'ok' });
      return { quote, source, startedAt, pool, owner };
    } catch (error) {
      const diagnostic = providers.state?.providers?.[source]?.lastDiagnostic;
      const failure = { source, at: Date.now(), amount, status: 'error', reason: error.message,
        diagnostic: diagnostic?.at >= startedAt ? diagnostic : undefined };
      failures.push(failure); record(failure);
    }
  }
  const error = new Error('all_exit_quotes_failed');
  error.failures = failures;
  throw error;
}
function retryDelay(failures) { return Math.min(300000, 5000 * 2 ** Math.min(6, Math.max(0, failures - 1))); }
function nextExit(positions, now = Date.now()) {
  return positions.filter(p => p.closedAt === null && (p.exitHealth?.nextRetryAt || 0) <= now).sort((a, b) =>
    Number(!!b.exitPending) - Number(!!a.exitPending) || (a.exitHealth?.nextRetryAt || 0) - (b.exitHealth?.nextRetryAt || 0)).slice(0, 1);
}
module.exports = { exitQuote, retryDelay, nextExit };
