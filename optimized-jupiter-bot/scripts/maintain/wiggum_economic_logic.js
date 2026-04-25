const TECHNICAL_MICRO_FAILURES = new Set(['send-failed', 'simulation-failed', 'probe-error']);

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) {
      const joined = value.filter((item) => typeof item === 'string' && item.trim()).join(',');
      if (joined) return joined;
    }
  }
  return null;
}

function buildResult({
  executionStatus,
  outcomeCode,
  outcome,
  status,
  acceptableForLive,
  orchestrationOutcome,
  reason,
  profitabilityMode,
  profitabilityPasses,
  microStatus,
  alphaStatus,
  alphaEffectiveMode,
}) {
  return {
    executionStatus,
    outcomeCode,
    outcome,
    economicAcceptance: {
      status,
      acceptableForLive,
      orchestrationOutcome,
      reason,
      profitabilityMode: profitabilityMode || null,
      profitabilityPasses: typeof profitabilityPasses === 'boolean' ? profitabilityPasses : null,
      microStatus: microStatus || null,
      alphaStatus: alphaStatus || null,
      alphaEffectiveMode: alphaEffectiveMode || null,
    },
  };
}

function deriveYieldEconomicResult({
  executionEnabled,
  actionable,
  walletRebalance,
  microTransaction,
  alphaExecution,
  alphaSafety,
}) {
  const liveMode = executionEnabled === true;
  const canAct = actionable !== false;
  const rebalanceAction = walletRebalance?.action || 'unknown';
  const microStatus = microTransaction?.status || 'missing';
  const profitability = microTransaction?.profitability || {};
  const profitabilityMode = profitability?.mode || null;
  const profitabilityPasses = typeof profitability?.passes === 'boolean' ? profitability.passes : null;
  const alphaStatus = alphaExecution?.status || 'missing';
  const alphaEffectiveMode = alphaExecution?.effectiveMode || alphaExecution?.mode || 'paper';
  const alphaReady = alphaStatus === 'armed' && alphaExecution?.ready === true;
  const riskReason = firstText(alphaSafety?.gateReasons, alphaSafety?.status === 'tripped' ? 'alpha-safety-tripped' : null);
  const blockReason = firstText(
    microTransaction?.blockReason,
    profitability?.reason,
    microTransaction?.error,
    riskReason,
    rebalanceAction,
    'unclassified',
  );

  if (TECHNICAL_MICRO_FAILURES.has(microStatus)) {
    return buildResult({
      executionStatus: liveMode ? 'live-failed' : 'dry-run',
      outcomeCode: 'live-failed',
      outcome: `Cycle failed: ${blockReason}`,
      status: 'technical-failure',
      acceptableForLive: false,
      orchestrationOutcome: 'failure',
      reason: blockReason,
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (microStatus === 'sent') {
    if (profitabilityPasses === false) {
      return buildResult({
        executionStatus: liveMode ? 'live-failed' : 'dry-run',
        outcomeCode: 'live-failed',
        outcome: `Cycle failed: sent trade violated profitability gate (${blockReason})`,
        status: 'technical-failure',
        acceptableForLive: false,
        orchestrationOutcome: 'failure',
        reason: firstText(blockReason, 'sent-with-negative-edge'),
        profitabilityMode,
        profitabilityPasses,
        microStatus,
        alphaStatus,
        alphaEffectiveMode,
      });
    }

    const isMaintenance = profitabilityMode === 'maintenance';
    return buildResult({
      executionStatus: 'live-sent',
      outcomeCode: isMaintenance ? 'live-sent-maintenance' : 'live-sent-profitable',
      outcome: isMaintenance
        ? 'Cycle completed with maintenance-driven live rebalance'
        : 'Cycle completed with profitable live rebalance',
      status: isMaintenance ? 'acceptable-maintenance' : 'acceptable-profitable',
      acceptableForLive: true,
      orchestrationOutcome: 'success',
      reason: firstText(profitability?.reason, isMaintenance ? 'maintenance-override' : 'profitability-passed'),
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (microStatus === 'ready-to-send') {
    if (profitabilityPasses === false) {
      return buildResult({
        executionStatus: liveMode ? 'live-failed' : 'dry-run',
        outcomeCode: 'live-failed',
        outcome: `Cycle failed: ready-to-send contradicted profitability gate (${blockReason})`,
        status: 'technical-failure',
        acceptableForLive: false,
        orchestrationOutcome: 'failure',
        reason: firstText(blockReason, 'ready-to-send-with-negative-edge'),
        profitabilityMode,
        profitabilityPasses,
        microStatus,
        alphaStatus,
        alphaEffectiveMode,
      });
    }

    return buildResult({
      executionStatus: liveMode ? 'live-ready-to-send' : 'dry-run-simulated',
      outcomeCode: liveMode ? 'live-ready-to-send' : 'dry-run-simulated',
      outcome: liveMode
        ? 'Cycle found a profitable rebalance and is ready to send'
        : 'Cycle dry-run completed with profitable simulated rebalance',
      status: liveMode ? 'acceptable-live-ready' : 'dry-run-simulated',
      acceptableForLive: liveMode,
      orchestrationOutcome: liveMode ? 'success' : 'hold',
      reason: firstText(profitability?.reason, 'ready-to-send'),
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (!liveMode) {
    if (microStatus === 'simulated-only') {
      return buildResult({
        executionStatus: 'dry-run-simulated',
        outcomeCode: 'dry-run-simulated',
        outcome: 'Cycle dry-run completed with simulated rebalance',
        status: 'dry-run-simulated',
        acceptableForLive: false,
        orchestrationOutcome: 'hold',
        reason: firstText(profitability?.reason, 'simulated-only'),
        profitabilityMode,
        profitabilityPasses,
        microStatus,
        alphaStatus,
        alphaEffectiveMode,
      });
    }

    if (alphaReady) {
      return buildResult({
        executionStatus: 'dry-run-alpha-armed',
        outcomeCode: 'dry-run-alpha-armed',
        outcome: 'Cycle dry-run completed with alpha opportunity armed',
        status: 'dry-run-alpha-armed',
        acceptableForLive: false,
        orchestrationOutcome: 'hold',
        reason: firstText(alphaExecution?.suggestedDirection, 'alpha-paper-armed'),
        profitabilityMode,
        profitabilityPasses,
        microStatus,
        alphaStatus,
        alphaEffectiveMode,
      });
    }

    return buildResult({
      executionStatus: 'dry-run',
      outcomeCode: 'dry-run',
      outcome: 'Cycle dry-run completed',
      status: 'dry-run',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: 'execution-disabled',
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (alphaSafety?.status === 'tripped') {
    return buildResult({
      executionStatus: 'live-blocked',
      outcomeCode: 'live-risk-hold',
      outcome: `Cycle holding: alpha safety tripped (${blockReason})`,
      status: 'hold-risk-tripped',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: blockReason,
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (alphaReady && alphaEffectiveMode === 'live') {
    return buildResult({
      executionStatus: 'live-alpha-armed',
      outcomeCode: 'live-alpha-armed',
      outcome: 'Cycle surfaced a live alpha opportunity',
      status: 'acceptable-alpha-live',
      acceptableForLive: true,
      orchestrationOutcome: 'success',
      reason: firstText(alphaExecution?.suggestedDirection, 'alpha-live-armed'),
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (!canAct) {
    return buildResult({
      executionStatus: 'live-monitoring',
      outcomeCode: 'live-low-balance',
      outcome: 'Cycle holding: wallet balance is below the live action threshold',
      status: 'hold-low-balance',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: 'below-min-cycle-wallet-sol',
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (microStatus === 'skipped-unprofitable') {
    return buildResult({
      executionStatus: 'live-skipped-unprofitable',
      outcomeCode: 'live-skipped-unprofitable',
      outcome: `Cycle holding: quote rebalance skipped as unprofitable (${blockReason})`,
      status: 'hold-unprofitable',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: blockReason,
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (microStatus === 'blocked') {
    return buildResult({
      executionStatus: 'live-blocked',
      outcomeCode: 'live-blocked',
      outcome: `Cycle holding: ${blockReason}`,
      status: 'hold-blocked',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: blockReason,
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  if (microStatus === 'not-needed') {
    return buildResult({
      executionStatus: 'live-monitoring',
      outcomeCode: 'live-no-action-needed',
      outcome: 'Cycle monitoring: no quote rebalance was needed',
      status: 'hold-no-action-needed',
      acceptableForLive: false,
      orchestrationOutcome: 'hold',
      reason: rebalanceAction,
      profitabilityMode,
      profitabilityPasses,
      microStatus,
      alphaStatus,
      alphaEffectiveMode,
    });
  }

  return buildResult({
    executionStatus: 'live-monitoring',
    outcomeCode: 'live-monitoring',
    outcome: 'Cycle monitoring: no profitable live action was taken',
    status: 'hold-monitoring',
    acceptableForLive: false,
    orchestrationOutcome: 'hold',
    reason: blockReason,
    profitabilityMode,
    profitabilityPasses,
    microStatus,
    alphaStatus,
    alphaEffectiveMode,
  });
}

function deriveYieldEconomicResultFromReport(report) {
  return deriveYieldEconomicResult({
    executionEnabled: report?.execution?.executionEnabled,
    actionable: report?.execution?.actionable,
    walletRebalance: report?.walletRebalance,
    microTransaction: report?.microTransaction,
    alphaExecution: report?.alphaExecution,
    alphaSafety: report?.alphaSafety,
  });
}

function deriveOrchestratorResult({ allStepsSucceeded, yieldReport, builderStatus }) {
  if (!allStepsSucceeded) {
    return {
      orchestrationOutcome: 'failure',
      reason: 'subprocess-failure',
      acceptableForLive: false,
      economicAcceptanceStatus: null,
      yieldExecutionStatus: yieldReport?.execution?.status || null,
      yieldOutcomeCode: yieldReport?.outcomeCode || null,
      yieldOutcome: yieldReport?.outcome || null,
      netGainLamports: Number(yieldReport?.microTransaction?.profitability?.netGainLamports || 0),
      builderStatus: builderStatus || null,
    };
  }

  if (!yieldReport) {
    return {
      orchestrationOutcome: 'failure',
      reason: 'missing-yield-report',
      acceptableForLive: false,
      economicAcceptanceStatus: null,
      yieldExecutionStatus: null,
      yieldOutcomeCode: null,
      yieldOutcome: null,
      netGainLamports: 0,
      builderStatus: builderStatus || null,
    };
  }

  const derived = deriveYieldEconomicResultFromReport(yieldReport);
  return {
    orchestrationOutcome: derived.economicAcceptance.orchestrationOutcome,
    reason: derived.economicAcceptance.reason,
    acceptableForLive: derived.economicAcceptance.acceptableForLive,
    economicAcceptanceStatus: derived.economicAcceptance.status,
    yieldExecutionStatus: derived.executionStatus,
    yieldOutcomeCode: derived.outcomeCode,
    yieldOutcome: derived.outcome,
    netGainLamports: Number(yieldReport?.microTransaction?.profitability?.netGainLamports || 0),
    builderStatus: builderStatus || yieldReport?.microTransaction?.status || null,
  };
}

module.exports = {
  TECHNICAL_MICRO_FAILURES,
  deriveYieldEconomicResult,
  deriveYieldEconomicResultFromReport,
  deriveOrchestratorResult,
};
