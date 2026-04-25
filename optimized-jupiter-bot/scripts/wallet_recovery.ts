import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
const {
  uniqueJournalTargets,
  shouldPersistTradeRecord,
} = require('./maintain/trade_journal_logic.ts');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const RPC_FALLBACK = process.env.RPC_ENDPOINT_2 || '';
const JUP_KEY = process.env.JUPITER_API_KEY || '';
const JUP_BASE = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || path.join(process.cwd(), 'wallet.json');
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const POSITIONS_FILE = path.join(
  SIGNALS_DIR,
  process.env.PAPER_MODE === 'true' ? 'sniper_positions_paper.json' : 'sniper_positions.json'
);
const JOURNAL_FILE = path.join(
  SIGNALS_DIR,
  process.env.PAPER_MODE === 'true' ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl'
);
const ROOT_JOURNAL_FILE = path.join(process.cwd(), 'trade_journal.jsonl');
const ARCHIVE_JOURNAL_FILE = path.join(SIGNALS_DIR, 'archive', 'trade_history.jsonl');
const STATE_FILE = path.join(SIGNALS_DIR, 'wallet_recovery_state.json');
const INTERVAL_MS = Math.max(60_000, parseInt(process.env.WALLET_RECOVERY_INTERVAL_MS || '600000', 10));
const ORPHAN_PRIORITY_FEE = Math.max(5000, parseInt(process.env.WALLET_RECOVERY_PRIORITY_FEE || '30000', 10));
const DUST_UI_MAX = Math.max(0, parseFloat(process.env.SNIPER_DUST_UI_MAX || '0.0001'));
const DUST_RAW_MAX = BigInt(Math.max(0, parseInt(process.env.SNIPER_DUST_RAW_MAX || '1000', 10)));
const RECOVERY_MINT_COOLDOWN_MS = Math.max(60_000, parseInt(process.env.WALLET_RECOVERY_MINT_COOLDOWN_MS || '900000', 10));
const SWAP_CONFIRM_TIMEOUT_MS = Math.max(15_000, parseInt(process.env.WALLET_RECOVERY_CONFIRM_TIMEOUT_MS || '45000', 10));
const SWAP_CONFIRM_POLL_MS = Math.max(1000, parseInt(process.env.WALLET_RECOVERY_CONFIRM_POLL_MS || '2000', 10));
const RUN_ONCE = process.argv.includes('--once');

const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const STABLE_MINTS = new Set([
  WSOL,
  USDC_MINT,
  'So11111111111111111111111111111111111111111',
]);

const connection = new Connection(RPC, { commitment: 'confirmed' });
const backupConnection = RPC_FALLBACK ? new Connection(RPC_FALLBACK, { commitment: 'confirmed' }) : null;
const recentRecoveredMints = new Map<string, number>();

let wallet: Keypair;
const walletIndex = process.env.WALLET_INDEX;
if (walletIndex && process.env[`PRIVATE_KEY_${walletIndex}`]) {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env[`PRIVATE_KEY_${walletIndex}`]!));
} else {
  const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
}

type ParsedTokenAmount = {
  amount: string;
  uiAmount: number;
};

type TrackedPosition = {
  mint?: string;
  _mint?: string;
};

function ensureSignalsDir() {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  if (!fs.existsSync(path.dirname(ARCHIVE_JOURNAL_FILE))) {
    fs.mkdirSync(path.dirname(ARCHIVE_JOURNAL_FILE), { recursive: true });
  }
}

function appendTrade(record: Record<string, unknown>) {
  ensureSignalsDir();
  if (!shouldPersistTradeRecord(record as { action?: string; sig?: string })) {
    console.warn(
      `[ATA RECOVERY] JOURNAL SKIP: blocked ${String(record?.action || 'TRADE')} for ` +
      `${String(record?.mint || record?.symbol || 'unknown')} due to ghost signature ${String(record?.sig || '')}`,
    );
    return;
  }
  const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
  const extraJournalTargets = process.env.PAPER_MODE === 'true'
    ? []
    : [ROOT_JOURNAL_FILE, ARCHIVE_JOURNAL_FILE];
  const targets = uniqueJournalTargets(JOURNAL_FILE, extraJournalTargets);
  for (const target of targets) {
    fs.appendFileSync(target, line, 'utf-8');
  }
}

function trimRecentRecovered(now = Date.now()) {
  for (const [mint, ts] of Array.from(recentRecoveredMints.entries())) {
    if (now - ts > RECOVERY_MINT_COOLDOWN_MS) recentRecoveredMints.delete(mint);
  }
}

function saveRecoveryState() {
  ensureSignalsDir();
  trimRecentRecovered();
  const payload = {
    updatedAt: Date.now(),
    recovered: Object.fromEntries(recentRecoveredMints.entries()),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

function loadRecoveryState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const recovered = raw?.recovered || {};
    const now = Date.now();
    for (const [mint, ts] of Object.entries(recovered)) {
      const num = Number(ts);
      if (Number.isFinite(num) && now - num <= RECOVERY_MINT_COOLDOWN_MS) {
        recentRecoveredMints.set(mint, num);
      }
    }
    trimRecentRecovered(now);
  } catch (e: any) { console.error('[ATA RECOVERY ERROR] Failed to parse target ATA structure. Backing off silently.'); }
}

function markRecovered(mint: string, now = Date.now()) {
  trimRecentRecovered(now);
  recentRecoveredMints.set(mint, now);
  saveRecoveryState();
}

function isRecoveryCoolingDown(mint: string, now = Date.now()) {
  trimRecentRecovered(now);
  const ts = recentRecoveredMints.get(mint);
  return typeof ts === 'number' && now - ts <= RECOVERY_MINT_COOLDOWN_MS;
}

function loadTrackedMints(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
    const positions = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.positions)
        ? raw.positions
        : [];
    const mints = positions
      .map((pos: TrackedPosition) => pos?.mint || pos?._mint)
      .filter((mint: string | undefined): mint is string => !!mint);
    return new Set(mints);
  } catch {
    return new Set();
  }
}

function loadBlacklistMints(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
    const blacklist: string[] = Array.isArray(raw?.blacklist) ? raw.blacklist : [];
    const strikes: Record<string, number> = raw?.strikes || {};

    // Add explicitly blacklisted items
    const badMints = new Set<string>(blacklist);

    // Add items with 3+ strikes
    for (const [mint, count] of Object.entries(strikes)) {
      if (count >= 3) {
        badMints.add(mint);
      }
    }
    return badMints;
  } catch {
    return new Set();
  }
}

async function jupFetch(endpoint: string, opts: RequestInit = {}) {
  const res = await fetch(`${JUP_BASE}${endpoint}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(JUP_KEY ? { 'x-api-key': JUP_KEY } : {}),
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return await res.json();
}

async function getQuote(inputMint: string, outputMint: string, amountLamports: number, slippageBps = 500) {
  try {
    const quote = await jupFetch(
      `/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`
    );
    if (quote?.error || !quote?.outAmount) return null;
    return quote;
  } catch {
    return null;
  }
}

async function executeSwap(quote: any, tipLamports = ORPHAN_PRIORITY_FEE) {
  try {
    const swapData = await jupFetch('/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: tipLamports,
      }),
    });
    if (!swapData?.swapTransaction) return null;
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);
    return await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
  } catch (e: any) {
    console.warn(`[RECOVERY] Swap failed: ${e.message}`);
    return null;
  }
}

async function waitForConfirmedSwap(sig: string): Promise<boolean> {
  const deadline = Date.now() + SWAP_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = await connection.getSignatureStatuses([sig], { searchTransactionHistory: false });
      const value = status?.value?.[0];
      if (value?.err) return false;
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') return true;
    } catch (e: any) { console.error('[ATA RECOVERY ERROR] Failed to parse target ATA structure. Backing off silently.'); }
    await new Promise((resolve) => setTimeout(resolve, SWAP_CONFIRM_POLL_MS));
  }
  return false;
}

async function getMintBalanceRaw(mint: string): Promise<bigint> {
  const sources = [connection, backupConnection].filter(Boolean) as Connection[];
  for (const conn of sources) {
    for (const programId of [TOKEN_PROG, TOKEN_PROG_22]) {
      try {
        const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, 'confirmed');
        let total = 0n;
        for (const account of accounts.value) {
          const info = (account.account.data as any).parsed.info;
          if (String(info.mint || '') !== mint) continue;
          total += BigInt(info.tokenAmount.amount || '0');
        }
        if (total > 0n) return total;
      } catch (e: any) { console.error('[ATA RECOVERY ERROR] Failed to parse target ATA structure. Backing off silently.'); }
    }
  }
  return 0n;
}

async function collectWalletTokens(): Promise<Map<string, ParsedTokenAmount>> {
  const seen = new Map<string, ParsedTokenAmount>();
  const sources = [connection, backupConnection].filter(Boolean) as Connection[];
  for (const conn of sources) {
    for (const programId of [TOKEN_PROG, TOKEN_PROG_22]) {
      try {
        const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, 'finalized');
        for (const account of accounts.value) {
          const info = (account.account.data as any).parsed.info;
          const mint = String(info.mint || '');
          const tokenAmount = info.tokenAmount || {};
          const uiAmount = Number(tokenAmount.uiAmount || 0);
          if (!mint || uiAmount <= 0) continue;
          seen.set(mint, {
            amount: String(tokenAmount.amount || '0'),
            uiAmount,
          });
        }
      } catch (e: any) { console.error('[ATA RECOVERY ERROR] Failed to parse target ATA structure. Backing off silently.'); }
    }
    if (seen.size > 0) break;
  }
  return seen;
}

async function recoverOrphans() {
  const tracked = loadTrackedMints();
  const seen = await collectWalletTokens();
  let sold = 0;
  for (const [mint, tokenAmount] of seen) {
    if (STABLE_MINTS.has(mint)) continue;
    if (tracked.has(mint)) continue;
    if (isRecoveryCoolingDown(mint)) continue;

    console.log(`[RECOVERY] Orphan found: ${mint.slice(0, 12)}... (${tokenAmount.uiAmount})`);
    const quote = await getQuote(mint, WSOL, Number(tokenAmount.amount));
    if (!quote) {
      console.log(`[RECOVERY] No route for orphan ${mint.slice(0, 12)}...`);
      markRecovered(mint);
      continue;
    }
    const sig = await executeSwap(quote);
    if (!sig) {
      markRecovered(mint);
      continue;
    }
    const confirmed = await waitForConfirmedSwap(sig);
    if (!confirmed) {
      console.warn(`[RECOVERY] Swap not confirmed for orphan ${mint.slice(0, 12)}...`);
      markRecovered(mint);
      continue;
    }
    const preRaw = BigInt(tokenAmount.amount || '0');
    const postRaw = await getMintBalanceRaw(mint);
    const reducedEnough = preRaw === 0n || postRaw * 100n < preRaw * 95n;
    if (!reducedEnough) {
      console.warn(
        `[RECOVERY] Orphan balance unchanged for ${mint.slice(0, 12)}... — pre ${preRaw.toString()} post ${postRaw.toString()}`
      );
      markRecovered(mint);
      continue;
    }
    sold++;
    markRecovered(mint);
    const solOut = Number(quote.outAmount) / 1e9;
    appendTrade({
      agent: 'pcp-recovery',
      action: 'SELL',
      mint,
      symbol: 'ORPHAN',
      amountSol: solOut,
      sig,
      reason: 'orphan-recovery',
      tradeId: `recovery-${Date.now()}-${mint.slice(0, 8)}`,
      priorityFee: ORPHAN_PRIORITY_FEE,
    });
    console.log(`[RECOVERY] Sold orphan ${mint.slice(0, 12)}... -> +${solOut.toFixed(5)} SOL`);
  }
  return { found: seen.size, sold };
}

async function reclaimAtaRentAndDust() {
  const reclaimable: Array<{
    pubkey: PublicKey;
    mint: string;
    amountRaw: bigint;
    uiAmount: number;
    programId: PublicKey;
    burnDust: boolean;
  }> = [];
  const tracked = loadTrackedMints();
  const blacklistMints = loadBlacklistMints();

  for (const conn of [connection, backupConnection].filter(Boolean) as Connection[]) {
    let added = 0;
    for (const programId of [TOKEN_PROG, TOKEN_PROG_22]) {
      try {
        const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, 'finalized');
        for (const account of accounts.value) {
          const info = (account.account.data as any).parsed.info;
          const mint = String(info.mint || '');
          if (!mint || STABLE_MINTS.has(mint) || tracked.has(mint)) continue;
          if (!blacklistMints.has(mint)) continue; // USER REQUEST: Only sweep if on bad list
          const amountRaw = BigInt(info.tokenAmount.amount || '0');
          const uiAmount = Number(info.tokenAmount.uiAmount || 0);
          if (amountRaw === 0n) {
            reclaimable.push({
              pubkey: new PublicKey(account.pubkey),
              mint,
              amountRaw,
              uiAmount,
              programId,
              burnDust: false,
            });
            added++;
            continue;
          }
          const isDust = uiAmount <= DUST_UI_MAX || amountRaw <= DUST_RAW_MAX;
          if (!isDust) continue;
          reclaimable.push({
            pubkey: new PublicKey(account.pubkey),
            mint,
            amountRaw,
            uiAmount,
            programId,
            burnDust: true,
          });
          added++;
        }
      } catch (e: any) { console.error('[ATA RECOVERY ERROR] Failed to parse target ATA structure. Backing off silently.'); }
    }
    if (added > 0) break;
  }

  let closed = 0;
  let burned = 0;
  for (const acct of reclaimable) {
    const tx = new Transaction();
    if (acct.burnDust && acct.amountRaw > 0n) {
      tx.add(
        createBurnInstruction(
          acct.pubkey,
          new PublicKey(acct.mint),
          wallet.publicKey,
          acct.amountRaw,
          [],
          acct.programId
        )
      );
    }
    tx.add(
      createCloseAccountInstruction(
        acct.pubkey,
        wallet.publicKey,
        wallet.publicKey,
        [],
        acct.programId
      )
    );
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
      closed++;
      if (acct.burnDust && acct.amountRaw > 0n) burned++;
      console.log(
        `[RECOVERY] ${acct.burnDust ? 'burn+close' : 'close'} ${acct.mint.slice(0, 8)}... | ui:${acct.uiAmount} | sig:${sig}`
      );
    } catch (e: any) {
      console.warn(`[RECOVERY] ATA recovery skipped ${acct.mint.slice(0, 8)}... - ${String(e.message || e).split('\n')[0]}`);
    }
  }
  return { candidates: reclaimable.length, closed, burned };
}

async function runSweep() {
  console.log(`[RECOVERY] Sweep start | wallet=${wallet.publicKey.toBase58()}`);
  const orphan = await recoverOrphans();
  const ata = await reclaimAtaRentAndDust();
  console.log(
    `[RECOVERY] Sweep done | tokens:${orphan.found} | sold:${orphan.sold} | ataCandidates:${ata.candidates} | closed:${ata.closed} | burned:${ata.burned}`
  );
}

async function main() {
  console.log(`[RECOVERY] Wallet recovery ${RUN_ONCE ? 'one-shot' : 'daemon'} online`);
  loadRecoveryState();
  await runSweep();
  if (RUN_ONCE) return;
  setInterval(() => {
    runSweep().catch((e) => console.error(`[RECOVERY] Sweep error: ${e.message}`));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error(`[RECOVERY] Fatal: ${e.message}`);
  process.exit(1);
});
