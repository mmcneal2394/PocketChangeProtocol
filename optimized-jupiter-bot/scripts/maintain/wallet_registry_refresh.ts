import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { buildWalletRegistryDocs } from './wallet_registry_refresh_logic';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const ROOT_DIR = process.cwd();
const SIGNALS_DIR = path.join(ROOT_DIR, 'signals');
const ALPHA_WALLETS_FILE = path.join(SIGNALS_DIR, 'alpha_wallets.json');
const KOL_WALLETS_FILE = path.join(SIGNALS_DIR, 'kol_wallets.json');
const WALLET_INTEL_FILE = path.join(SIGNALS_DIR, 'wallet_intel.json');
const WALLET_PNL_FILE = path.join(SIGNALS_DIR, 'wallet_pnl.json');
const GMGN_SMARTMONEY_FILE = path.join(SIGNALS_DIR, 'gmgn_smartmoney.json');

const REFRESH_MS = Math.max(60_000, Number(process.env.WALLET_REGISTRY_REFRESH_MS || 15 * 60_000));
const ALPHA_LIMIT = Math.max(4, Number(process.env.ALPHA_REGISTRY_LIMIT || 16));
const KOL_LIMIT = Math.max(2, Number(process.env.KOL_REGISTRY_LIMIT || 8));

function ensureSignalsDir() {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function loadJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: unknown) {
  ensureSignalsDir();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const docs = buildWalletRegistryDocs({
    alphaDoc: loadJsonSafe(ALPHA_WALLETS_FILE, {}),
    kolDoc: loadJsonSafe(KOL_WALLETS_FILE, {}),
    walletIntelDoc: loadJsonSafe(WALLET_INTEL_FILE, {}),
    walletPnlDoc: loadJsonSafe(WALLET_PNL_FILE, {}),
    gmgnSmartMoneyDoc: loadJsonSafe(GMGN_SMARTMONEY_FILE, {}),
    alphaLimit: ALPHA_LIMIT,
    kolLimit: KOL_LIMIT,
    nowIso,
  });

  writeJson(ALPHA_WALLETS_FILE, docs.alphaDoc);
  writeJson(KOL_WALLETS_FILE, docs.kolDoc);

  console.log(
    `[WALLET-REGISTRY] alpha=${docs.alphaDoc.tracked_wallets.length} ` +
    `kol=${docs.kolDoc.tracked_wallets.length} ` +
    `topAlpha=${docs.alphaDoc.summary.top_wallet || 'none'} ` +
    `topKol=${docs.kolDoc.summary.top_wallet || 'none'}`,
  );
}

async function mainLoop() {
  ensureSignalsDir();
  console.log('[WALLET-REGISTRY] Starting wallet registry refresh');
  while (true) {
    try {
      await runCycle();
    } catch (error: any) {
      console.error('[WALLET-REGISTRY] Cycle failure:', error?.message || error);
    }
    await sleep(REFRESH_MS);
  }
}

mainLoop().catch((error) => {
  console.error('[WALLET-REGISTRY] fatal:', error?.message || error);
  process.exitCode = 1;
});

