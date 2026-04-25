#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const {
  enqueueOpportunity,
  getEngineState,
  getLatestOpportunity,
  summarizeCoordinator,
  upsertEngineState,
} = require('./engine_state_store');

const SCOUT_STATE_DIR = path.join(process.cwd(), '.swarm', 'arb-scout');

function fail(message) {
  console.error(`[ARB_SCOUT] ${message}`);
  process.exit(1);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadProfile() {
  const profilePath = path.resolve(process.cwd(), process.env.STRATEGY_PROFILE_PATH || 'config/strategy-profiles/active.strategy.json');
  if (!fs.existsSync(profilePath)) {
    fail(`Strategy profile not found: ${profilePath}`);
  }
  return {
    profilePath,
    profile: JSON.parse(fs.readFileSync(profilePath, 'utf8')),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + (Math.max(0, Number(seconds || 0)) * 1000)).toISOString();
}

function getAgeSeconds(isoString) {
  if (!isoString) return Number.POSITIVE_INFINITY;
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((Date.now() - then) / 1000));
}

function getScoutConfig(profile) {
  const scout = profile.arbScout || {};
  return {
    enabled: scout.enabled === true,
    source: scout.source || 'yield-cycle-alpha',
    minNetEdgeBps: Math.max(0, Number(scout.minNetEdgeBps || 12)),
    minReadinessScore: Math.max(0, Number(scout.minReadinessScore || 60)),
    maxReportAgeSeconds: Math.max(30, Number(scout.maxReportAgeSeconds || 180)),
    cooldownSeconds: Math.max(0, Number(scout.cooldownSeconds || 90)),
    opportunityTtlSeconds: Math.max(30, Number(scout.opportunityTtlSeconds || 180)),
    requireStrategyGate: scout.requireStrategyGate !== false,
  };
}

function buildCandidateSummary(report) {
  const candidate = report?.alphaCandidate || {};
  const best = candidate.best || {};
  return {
    qualifies: Boolean(candidate.qualifies),
    direction: best.direction || candidate.direction || 'no-positive-spread',
    venue: best.name || null,
    netEdgeBps: Number(best.netEdgeBps || candidate.netEdgeBps || 0),
    estimatedProfitLamports: Math.floor(Number(best.estimatedNetLamports || report?.microTransaction?.profitability?.netGainLamports || 0)),
    referencePrice: Number(best.referencePrice || 0),
    jupiterImpliedSolUsd: Number(candidate.jupiterImpliedSolUsd || 0),
    priceImpactPct: Number(best.priceImpactPct || candidate.jupiterPriceImpactPct || 0),
    raw: candidate,
  };
}

function determineScoutOutcome({ config, latestYieldReport, strategyGateState, yieldEngineState, previousOpportunity }) {
  if (!config.enabled) {
    return { state: 'idle', reason: 'arb-scout-disabled', candidate: null, opportunity: null };
  }

  if (!latestYieldReport) {
    return { state: 'blocked', reason: 'missing-yield-cycle-report', candidate: null, opportunity: null };
  }

  const reportAgeSeconds = getAgeSeconds(latestYieldReport.generatedAt);
  if (reportAgeSeconds > config.maxReportAgeSeconds) {
    return {
      state: 'degraded',
      reason: `stale-yield-cycle-report:${reportAgeSeconds}s`,
      candidate: null,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (config.requireStrategyGate && strategyGateState && ['blocked', 'degraded', 'kill_switch'].includes(strategyGateState.state)) {
    return {
      state: 'blocked',
      reason: `strategy-gate-${strategyGateState.state}`,
      candidate: null,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (yieldEngineState && ['kill_switch', 'degraded'].includes(yieldEngineState.state)) {
    return {
      state: 'blocked',
      reason: `yield-cycle-${yieldEngineState.state}`,
      candidate: null,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (latestYieldReport.alphaSafety?.status === 'tripped') {
    return {
      state: 'kill_switch',
      reason: 'yield-alpha-safety-tripped',
      candidate: null,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  const candidate = buildCandidateSummary(latestYieldReport);
  const readinessScore = Number(latestYieldReport?.alphaReadiness?.score || 0);
  const readinessReady = latestYieldReport?.alphaReadiness?.ready === true;
  const cooldownActive = previousOpportunity
    && previousOpportunity.status === 'open'
    && getAgeSeconds(previousOpportunity.createdAt) < config.cooldownSeconds;

  if (cooldownActive) {
    return {
      state: 'cooldown',
      reason: 'recent-open-opportunity',
      candidate,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (!candidate.qualifies) {
    return {
      state: 'idle',
      reason: 'no-qualified-spread',
      candidate,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (candidate.netEdgeBps < config.minNetEdgeBps) {
    return {
      state: 'idle',
      reason: `edge-below-threshold:${candidate.netEdgeBps}`,
      candidate,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  if (!readinessReady || readinessScore < config.minReadinessScore) {
    return {
      state: 'idle',
      reason: `readiness-below-threshold:${readinessScore}`,
      candidate,
      opportunity: null,
      reportAgeSeconds,
    };
  }

  return {
    state: 'armed',
    reason: 'qualified-arb-opportunity',
    candidate,
    opportunity: {
      source: 'arb-scout',
      status: 'open',
      direction: candidate.direction,
      netEdgeBps: candidate.netEdgeBps,
      estimatedProfitLamports: candidate.estimatedProfitLamports,
      expiresAt: addSeconds(nowIso(), config.opportunityTtlSeconds),
      payload: {
        source: config.source,
        reportGeneratedAt: latestYieldReport.generatedAt,
        readinessScore,
        readinessReady,
        candidate,
      },
    },
    reportAgeSeconds,
  };
}

function main() {
  const { profile, profilePath } = loadProfile();
  const config = getScoutConfig(profile);
  const latestYieldReport = readJsonIfExists(path.join(process.cwd(), '.swarm', 'yield-cycle', 'latest-cycle.json'));
  const strategyGateState = getEngineState('strategy-gate');
  const yieldEngineState = getEngineState('yield-cycle');
  const previousOpportunity = getLatestOpportunity({ source: 'arb-scout' });
  const outcome = determineScoutOutcome({
    config,
    latestYieldReport,
    strategyGateState,
    yieldEngineState,
    previousOpportunity,
  });

  fs.mkdirSync(SCOUT_STATE_DIR, { recursive: true });

  const opportunity = outcome.opportunity ? enqueueOpportunity(outcome.opportunity) : null;
  const engineState = upsertEngineState('arb-scout', {
    state: outcome.state,
    reason: outcome.reason,
    cooldownUntil: outcome.state === 'cooldown' ? addSeconds(nowIso(), config.cooldownSeconds) : null,
    metadata: {
      profileId: profile.id,
      strategyGateState: strategyGateState?.state || null,
      yieldEngineState: yieldEngineState?.state || null,
      reportGeneratedAt: latestYieldReport?.generatedAt || null,
      reportAgeSeconds: Number(outcome.reportAgeSeconds || 0),
      opportunityId: opportunity?.id || null,
    },
  });

  const reserveLamports = Math.floor(Number(profile?.yieldCycle?.minNativeSolReserve || 0) * 1_000_000_000);
  const walletLamports = Number(latestYieldReport?.balances?.lamports || 0);
  const report = {
    generatedAt: nowIso(),
    profilePath,
    strategyId: profile.id,
    state: engineState,
    scoutConfig: config,
    candidate: outcome.candidate,
    opportunity,
    reportAgeSeconds: Number(outcome.reportAgeSeconds || 0),
    strategyGateState,
    yieldEngineState,
    coordination: summarizeCoordinator({ walletLamports, reserveLamports }),
    outcome: outcome.state === 'armed'
      ? 'Arbitrage scout found a qualified opportunity'
      : 'Arbitrage scout completed without publishing a live opportunity',
  };

  const latestPath = path.join(SCOUT_STATE_DIR, 'latest-scout.json');
  const historyPath = path.join(SCOUT_STATE_DIR, `scout-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(historyPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[ARB_SCOUT] Strategy: ${report.strategyId}`);
  console.log(`[ARB_SCOUT] State: ${report.state.state}`);
  console.log(`[ARB_SCOUT] Reason: ${report.state.reason}`);
  if (report.candidate) {
    console.log(`[ARB_SCOUT] Candidate direction: ${report.candidate.direction}`);
    console.log(`[ARB_SCOUT] Candidate net edge bps: ${report.candidate.netEdgeBps}`);
  }
  if (report.opportunity) {
    console.log(`[ARB_SCOUT] Published opportunity id: ${report.opportunity.id}`);
  }
  console.log(report.outcome);
}

main();
