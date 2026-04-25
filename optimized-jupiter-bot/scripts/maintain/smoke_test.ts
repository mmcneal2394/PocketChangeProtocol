import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { Keypair } from '@solana/web3.js';

dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const PKG_ROOT = process.cwd();
const REPO_ROOT = path.resolve(PKG_ROOT, '..');
const SIGNALS_DIR = path.join(PKG_ROOT, 'signals');
const TEMP_WALLET_FILE = path.join(SIGNALS_DIR, 'smoke_wallet.json');
const DEFAULT_RPC = process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

type SmokeResult = {
  name: string;
  ok: boolean;
  detail: string;
};

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createTempWalletFile() {
  ensureDir(SIGNALS_DIR);
  const wallet = Keypair.generate();
  fs.writeFileSync(TEMP_WALLET_FILE, JSON.stringify(Array.from(wallet.secretKey)), 'utf8');
  return TEMP_WALLET_FILE;
}

function cleanupTempWalletFile() {
  if (fs.existsSync(TEMP_WALLET_FILE)) fs.unlinkSync(TEMP_WALLET_FILE);
}

async function runCommand(args: {
  name: string;
  command: string;
  commandArgs: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  successPattern?: RegExp;
  killOnSuccessPattern?: boolean;
}): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const child = spawn(args.command, args.commandArgs, {
      cwd: args.cwd,
      env: args.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let matched = false;
    let finished = false;

    const finish = (ok: boolean, detail: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ name: args.name, ok, detail });
    };

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (args.successPattern?.test(output)) {
        matched = true;
        if (args.killOnSuccessPattern && !child.killed) {
          child.kill('SIGTERM');
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (error) => {
      finish(false, String(error?.message || error));
    });

    child.on('close', (code, signal) => {
      const compactOutput = output.trim().split('\n').filter(Boolean).slice(-8).join(' | ') || 'no output';
      if (matched) {
        finish(true, compactOutput);
        return;
      }
      if (code === 0) {
        if (!args.successPattern || args.successPattern.test(output)) {
          finish(true, compactOutput);
          return;
        }
      }
      finish(false, `exit=${code ?? 'null'} signal=${signal ?? 'null'} | ${compactOutput}`);
    });

    const timer = setTimeout(() => {
      const compactOutput = output.trim().split('\n').filter(Boolean).slice(-8).join(' | ') || 'timeout';
      if (matched) {
        if (!child.killed) child.kill('SIGTERM');
        finish(true, compactOutput);
        return;
      }
      if (!child.killed) child.kill('SIGTERM');
      finish(false, `timeout after ${args.timeoutMs || 0}ms | ${compactOutput}`);
    }, args.timeoutMs || 15_000);
  });
}

async function main() {
  const tempWalletPath = createTempWalletFile();
  const smokeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PAPER_MODE: 'true',
    RPC_ENDPOINT: DEFAULT_RPC,
    SOLANA_RPC_URL: DEFAULT_RPC,
    JUPITER_API_KEY: process.env.JUPITER_API_KEY || 'dryrun',
    WALLET_KEYPAIR_PATH: tempWalletPath,
  };

  const results: SmokeResult[] = [];

  try {
    results.push(await runCommand({
      name: 'guardian',
      command: 'node',
      commandArgs: ['--require', 'ts-node/register/transpile-only', 'scripts/maintain/slopfest_guardian.ts', '--once'],
      cwd: PKG_ROOT,
      env: smokeEnv,
      timeoutMs: 20_000,
      successPattern: /\[GUARDIAN\]/,
    }));

    results.push(await runCommand({
      name: 'allocator',
      command: 'node',
      commandArgs: ['--require', 'ts-node/register/transpile-only', 'scripts/maintain/capital_allocator.ts', '--once'],
      cwd: PKG_ROOT,
      env: smokeEnv,
      timeoutMs: 20_000,
      successPattern: /\[ALLOCATOR\]/,
    }));

    results.push(await runCommand({
      name: 'arb-scout',
      command: 'node',
      commandArgs: ['scripts/live_arbitrage_engine.mjs', '--once'],
      cwd: REPO_ROOT,
      env: smokeEnv,
      timeoutMs: 30_000,
      successPattern: /(\[ARB\]|No WALLET_SECRET_KEYS_B58 values provided)/,
    }));

    results.push(await runCommand({
      name: 'sniper-paper-boot',
      command: 'node',
      commandArgs: ['--require', 'ts-node/register/transpile-only', 'scripts/maintain/momentum_sniper.ts'],
      cwd: PKG_ROOT,
      env: smokeEnv,
      timeoutMs: 20_000,
      successPattern: /(Quota status:|Wallet:|Native SOL:)/,
      killOnSuccessPattern: true,
    }));
  } finally {
    cleanupTempWalletFile();
  }

  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`[SMOKE] ${status} | ${result.name} | ${result.detail}`);
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    console.error(`[SMOKE] FAILURES=${failures.length}`);
    process.exit(1);
  }

  console.log(`[SMOKE] PASS | systems=${results.length}`);
}

main().catch((error: any) => {
  cleanupTempWalletFile();
  console.error(`[SMOKE] FATAL | ${error?.message || error}`);
  process.exit(1);
});
