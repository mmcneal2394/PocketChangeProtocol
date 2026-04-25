#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const { getEngineState, upsertEngineState } = require('./engine_state_store');

function fail(message) {
  console.error(`[STRATEGY_GATE] ${message}`);
  process.exit(1);
}

function runStep(label, command, env = {}) {
  console.log(`[STRATEGY_GATE] Running ${label}...`);
  const result = spawnSync(command, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    shell: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function loadProfile() {
  const profilePath = path.resolve(process.cwd(), process.env.STRATEGY_PROFILE_PATH || 'config/strategy-profiles/active.strategy.json');
  if (!fs.existsSync(profilePath)) {
    fail(`Strategy profile not found: ${profilePath}`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!profile.id || !profile.description || !profile.mode || !profile.walletPublicKey) {
    fail('Strategy profile must include id, description, mode, and walletPublicKey');
  }
  return { profile, profilePath };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getGateConfig(profile) {
  const gates = profile.gates || {};
  return {
    requireYieldCycleFreshness: gates.requireYieldCycleFreshness !== false,
    maxYieldCycleAgeSeconds: Math.max(60, Number(gates.maxYieldCycleAgeSeconds || 3 * 60 * 60)),
    blockOnKillSwitch: gates.blockOnKillSwitch !== false,
  };
}

function getAgeSeconds(isoString) {
  if (!isoString) return Number.POSITIVE_INFINITY;
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((Date.now() - then) / 1000));
}

function failWithState(message, metadata = {}) {
  upsertEngineState('strategy-gate', {
    state: 'blocked',
    reason: message,
    metadata,
  });
  fail(message);
}

function main() {
  const { profile, profilePath } = loadProfile();
  console.log(`[STRATEGY_GATE] Loaded profile ${profile.id} from ${profilePath}`);
  const gateConfig = getGateConfig(profile);

  const configuredWalletPub = process.env.WALLET_PUBLIC_KEY || '';
  const configuredWalletPath = process.env.WALLET_KEYPAIR_PATH || '';
  if (configuredWalletPub && configuredWalletPub !== profile.walletPublicKey) {
    failWithState(`WALLET_PUBLIC_KEY mismatch. env=${configuredWalletPub} profile=${profile.walletPublicKey}`, { profileId: profile.id });
  }
  if (profile.walletKeypairPath && configuredWalletPath && profile.walletKeypairPath !== configuredWalletPath) {
    failWithState(`WALLET_KEYPAIR_PATH mismatch. env=${configuredWalletPath} profile=${profile.walletKeypairPath}`, { profileId: profile.id });
  }

  const derivedMinBuySol = (() => {
    const microLamports = Number(profile?.yieldCycle?.microTransaction?.amountLamports || 0);
    if (Number.isFinite(microLamports) && microLamports > 0) {
      return String(microLamports / 1_000_000_000);
    }
    const minCycleWalletSol = Number(profile?.yieldCycle?.minCycleWalletSol || 0);
    if (Number.isFinite(minCycleWalletSol) && minCycleWalletSol > 0) {
      return String(minCycleWalletSol);
    }
    const preflightLamports = Number(profile?.preflight?.buyLamports || 0);
    if (Number.isFinite(preflightLamports) && preflightLamports > 0) {
      return String(preflightLamports / 1_000_000_000);
    }
    return process.env.SNIPER_MIN_BUY || '0.01';
  })();

  const gateEnv = {
    PAPER_MODE: profile.mode === 'paper' ? 'true' : process.env.PAPER_MODE || 'false',
    STRATEGY_PROFILE_ID: profile.id,
    SNIPER_MIN_BUY: derivedMinBuySol,
  };

  const preflightEnv = {
    ...gateEnv,
    PREFLIGHT_INPUT_MINT: profile.preflight?.inputMint || '',
    PREFLIGHT_OUTPUT_MINT: profile.preflight?.outputMint || '',
    PREFLIGHT_BUY_LAMPORTS: profile.preflight?.buyLamports || '',
  };

  const yieldState = getEngineState('yield-cycle');
  const arbScoutState = getEngineState('arb-scout');
  if (gateConfig.blockOnKillSwitch) {
    if (yieldState?.state === 'kill_switch') {
      failWithState('yield-cycle is in kill_switch state', { yieldState, arbScoutState, profileId: profile.id });
    }
    if (arbScoutState?.state === 'kill_switch') {
      failWithState('arb-scout is in kill_switch state', { yieldState, arbScoutState, profileId: profile.id });
    }
  }

  const latestYieldReport = readJsonIfExists(path.join(process.cwd(), '.swarm', 'yield-cycle', 'latest-cycle.json'));
  const latestYieldAgeSeconds = getAgeSeconds(latestYieldReport?.generatedAt);
  if (gateConfig.requireYieldCycleFreshness && latestYieldReport && latestYieldAgeSeconds > gateConfig.maxYieldCycleAgeSeconds) {
    failWithState(`yield-cycle report is stale (${latestYieldAgeSeconds}s old)`, {
      yieldState,
      arbScoutState,
      latestYieldAgeSeconds,
      profileId: profile.id,
    });
  }
  if (latestYieldReport?.alphaSafety?.status === 'tripped') {
    failWithState('yield-cycle alpha safety is tripped', {
      yieldState,
      arbScoutState,
      latestYieldAgeSeconds,
      profileId: profile.id,
      alphaSafety: latestYieldReport.alphaSafety,
    });
  }

  try {
    if (profile.gates?.requireReadiness !== false) {
      runStep('readiness check', 'node --require ts-node/register/transpile-only scripts/readiness_check.ts', gateEnv);
    }
    if (profile.gates?.requirePreflight !== false && profile.preflight?.enabled !== false) {
      if (!preflightEnv.PREFLIGHT_INPUT_MINT || !preflightEnv.PREFLIGHT_OUTPUT_MINT || !preflightEnv.PREFLIGHT_BUY_LAMPORTS) {
        failWithState('Preflight is enabled but the strategy profile is missing route settings', {
          profileId: profile.id,
          preflight: profile.preflight || null,
        });
      }
      runStep('preflight check', 'node --require ts-node/register/transpile-only scripts/maintain/preflight_loop.ts', preflightEnv);
    }
  } catch (error) {
    failWithState(error.message, {
      yieldState,
      arbScoutState,
      latestYieldAgeSeconds,
      profileId: profile.id,
    });
  }

  upsertEngineState('strategy-gate', {
    state: 'armed',
    reason: 'all-gates-passed',
    metadata: {
      profileId: profile.id,
      latestYieldAgeSeconds,
      yieldState: yieldState?.state || null,
      arbScoutState: arbScoutState?.state || null,
    },
  });
  console.log('STRATEGY_GATE_PASSED');
}

main();
