/**
 * smoke_test.ts  —  Junior agent: fast pipeline validation (--duration 0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs dry_run_sim with duration=0 (screen + exit), parses output for
 * known failure patterns, writes smoke_test_result.json, exits 0/1.
 *
 * Usage:
 *   npx ts-node scripts/maintain/smoke_test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execSync, spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';

const RESULT_FILE = path.join(process.cwd(), 'smoke_test_result.json');

interface SmokeResult {
  timestamp:    string;
  passed:       boolean;
  durationMs:   number;
  checks:       Array<{ name: string; passed: boolean; detail?: string }>;
  rawStdout:    string;
  rawStderr:    string;
}

function run(): SmokeResult {
  const start = Date.now();
  const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];

  console.log('[SMOKE] Running dry_run_sim --duration 0...');
  const result = spawnSync(
    'npx', ['ts-node', '--transpile-only', 'scripts/dry_run_sim.ts', '--capital', '200', '--duration', '0'],
    { cwd: process.cwd(), encoding: 'utf-8', timeout: 180_000 }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const durationMs = Date.now() - start;

  // ── Check 1: Process exit code ───────────────────────────────────────────────
  checks.push({
    name: 'exit_code_zero',
    passed: result.status === 0,
    detail: result.status !== 0 ? `exit ${result.status}` : undefined,
  });

  // ── Check 2: Env vars validated ──────────────────────────────────────────────
  checks.push({
    name: 'env_vars_present',
    passed: stdout.includes('All required env variables present'),
  });

  // ── Check 3: SOL price fetched ───────────────────────────────────────────────
  const priceMatch = stdout.match(/SOL price: \$(\d+\.\d+)/);
  checks.push({
    name: 'sol_price_fetched',
    passed: !!priceMatch,
    detail: priceMatch ? `$${priceMatch[1]}` : 'not found in output',
  });

  // ── Check 4: Tokens found ────────────────────────────────────────────────────
  const tokensMatch = stdout.match(/Found (\d+) candidate tokens/);
  const tokenCount  = tokensMatch ? parseInt(tokensMatch[1]) : 0;
  checks.push({
    name: 'candidates_found',
    passed: tokenCount > 0,
    detail: `${tokenCount} tokens`,
  });

  // ── Check 5: Screening completed ─────────────────────────────────────────────
  checks.push({
    name: 'screening_completed',
    passed: stdout.includes('passed screening'),
  });

  // ── Check 6: No TypeScript errors ────────────────────────────────────────────
  checks.push({
    name: 'no_ts_errors',
    passed: !stderr.includes('TSError') && !stderr.includes('error TS'),
    detail: stderr.includes('TSError') ? 'TypeScript compile error detected' : undefined,
  });

  // ── Check 7: No unhandled exceptions ─────────────────────────────────────────
  checks.push({
    name: 'no_unhandled_exceptions',
    passed: !stderr.includes('UnhandledPromiseRejection') && !stdout.includes('Simulation error'),
    detail: stderr.includes('UnhandledPromiseRejection') ? 'Unhandled rejection in output' : undefined,
  });

  const passed = checks.every(c => c.passed);
  return { timestamp: new Date().toISOString(), passed, durationMs, checks, rawStdout: stdout, rawStderr: stderr };
}

// ── Entry ──────────────────────────────────────────────────────────────────────
const result = run();
fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

const icon  = result.passed ? '✅' : '❌';
const fails = result.checks.filter(c => !c.passed).map(c => `  ✗ ${c.name}: ${c.detail || 'failed'}`).join('\n');
console.log(
  `\n[SMOKE] ${icon} ${result.passed ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'} (${result.durationMs}ms)\n` +
  result.checks.map(c => `  ${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ': ' + c.detail : ''}`).join('\n')
);

process.exit(result.passed ? 0 : 1);
