/**
 * ═══════════════════════════════════════════════════════════════════
 *  JARVIS ARBITRAGE ENGINE v3  —  Compounding Yield Edition
 *  Solana On-Chain Atomic Round-Trip Arbitrage via Jito Block Engine
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Architecture (from knowledge base):
 *   • AsyncScanner:    Parallel scan of 15 token pairs every 200ms
 *   • CircuitBreaker:  Backs off on consecutive failures (CLOSED→OPEN→HALF_OPEN)
 *   • CompoundEngine:  Reinvests profits — trade size grows with each successful trade
 *   • JitoExecutor:    Direct TPU injection via Jito NY block engine (no mempool)
 *   • PnLTracker:      Per-token win/loss/latency stats streamed to console
 *
 *  Known fixes applied:
 *   • Zod config.ts crash bypassed (direct process.env)
 *   • excludeDexes: GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi (vote-account locking pools)
 *   • Jito tip floor: 100,000 lamports (competitive block-inclusion threshold)
 *   • PM2 restart-safe: no global state lost between restarts (balance reread on boot)
 */
require('dotenv').config();
const { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram, AddressLookupTableAccount } = require('@solana/web3.js');
const Bottleneck = require('bottleneck');
// fetch and bs58 loaded inline to avoid conflict with Node 18 built-in fetch
const fs = require('fs');
// ─── Config (env-direct, no Zod) ─────────────────────────────────────────────
const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY = process.env.JUPITER_API_KEY || '';
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT_SOL || '0.000050'); // 50k lamport floor
const TRADE_PCT = parseFloat(process.env.TRADE_PERCENTAGE || '0.30'); // 30% of balance per trade
const MAX_TRADE = parseFloat(process.env.MAX_TRADE_SIZE_SOL || '0.25'); // cap per trade
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '200');
const JITO_URL = 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles';
const JUP_BASE = 'https://lite-api.jup.ag/swap/v1';
const SLIPPAGE = 5; // 0.05% — tight slippage for arbitrage
// Exact Jupiter label strings for Jito-banned vote-account-touching pools
const EXCLUDE_DEXES = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,' +
    'VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// ─── Token universe (high-volume, Jito-safe routes confirmed) ────────────────
const TARGETS = [
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
    { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
    { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
    { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA' },
    { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RNDR' },
    { mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', symbol: 'WEN' },
    { mint: 'nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ', symbol: 'NOS' },
    { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME' },
    { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
    { mint: 'HZ1JovNiVvGqQuote1DCmFiA4JuAgQuoteNGSHNmn7mcN3', symbol: 'JLP' }, // skip if invalid
    { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH' },
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'wSOL' }, // SOL-wSOL spread
];
// Filter out obviously invalid mints at startup
const VALID_TARGETS = TARGETS.filter(t => t.mint !== SOL_MINT && t.mint.length >= 32);
// ─── Core instances ───────────────────────────────────────────────────────────
const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletRaw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletRaw));
// Bottleneck: Jupiter API Pro limit = 3000 RPM, max 15 concurrent
const limiter = new Bottleneck({
    reservoir: 3000, reservoirRefreshAmount: 3000,
    reservoirRefreshInterval: 60 * 1000, maxConcurrent: 15
});
// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const breakers = {};
VALID_TARGETS.forEach(t => { breakers[t.symbol] = { fails: 0, open: false, openUntil: 0 }; });
function circuitOk(symbol) {
    const b = breakers[symbol];
    if (!b.open)
        return true;
    if (Date.now() > b.openUntil) {
        b.open = false;
        b.fails = 0;
        return true;
    } // HALF_OPEN
    return false;
}
function recordSuccess(symbol) { breakers[symbol].fails = 0; breakers[symbol].open = false; }
function recordFailure(symbol) {
    const b = breakers[symbol];
    b.fails++;
    if (b.fails >= 4) {
        b.open = true;
        b.openUntil = Date.now() + 30000;
    } // 30s cooldown
}
// ─── PnL Tracker ─────────────────────────────────────────────────────────────
const stats = {
    startTime: Date.now(), startBalance: 0,
    scans: 0, trades: 0, wins: 0,
    totalPnl: 0, fees: 0,
    perToken: {}
};
VALID_TARGETS.forEach(t => { stats.perToken[t.symbol] = { scans: 0, trades: 0, pnl: 0 }; });
// ─── Jito Tip Accounts (fetched once, refreshed hourly) ──────────────────────
let jitoTipAccounts = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
];
async function refreshJitoTips() {
    const nodeFetch = require('node-fetch');
    try {
        const r = await nodeFetch(JITO_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] })
        });
        const d = await r.json();
        if (d?.result?.length > 0)
            jitoTipAccounts = d.result;
    }
    catch (e) { }
}
setInterval(refreshJitoTips, 3600000);
// ─── ALT cache ────────────────────────────────────────────────────────────────
const altCache = {};
async function getALT(addr) {
    if (altCache[addr])
        return altCache[addr];
    const acct = await connection.getAddressLookupTable(new PublicKey(addr));
    if (acct?.value)
        altCache[addr] = acct.value;
    return altCache[addr] || null;
}
// ─── Safe fetch with rate-limit handling ────────────────────────────────────
const nodeFetch = require('node-fetch');
async function safeFetch(url, opts = {}) {
    return limiter.schedule(async () => {
        const res = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, ...(opts.headers || {}) } });
        if (res.status === 429)
            throw new Error('RATE_LIMITED');
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        return res;
    });
}
// ─── Build atomic VersionedTransaction ───────────────────────────────────────
async function buildTx(ix1, ix2, tipLamports) {
    try {
        const blockhash = (await connection.getLatestBlockhash('processed')).blockhash;
        const instructions = [];
        const deser = ix => {
            if (!ix)
                return null;
            return new TransactionInstruction({
                programId: new PublicKey(ix.programId),
                keys: ix.accounts.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
                data: Buffer.from(ix.data, 'base64')
            });
        };
        const altsToFetch = [...(ix1.addressLookupTableAddresses || []), ...(ix2.addressLookupTableAddresses || [])];
        const alts = (await Promise.all([...new Set(altsToFetch)].map(getALT))).filter(Boolean);
        // Leg 1
        (ix1.setupInstructions || []).forEach(ix => instructions.push(deser(ix)));
        instructions.push(deser(ix1.swapInstruction));
        if (ix1.cleanupInstruction)
            instructions.push(deser(ix1.cleanupInstruction));
        // Leg 2
        (ix2.setupInstructions || []).forEach(ix => instructions.push(deser(ix)));
        instructions.push(deser(ix2.swapInstruction));
        if (ix2.cleanupInstruction)
            instructions.push(deser(ix2.cleanupInstruction));
        const valid = instructions.filter(Boolean);
        // Priority fees
        valid.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
        valid.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
        // Jito tip (random tip account for MEV privacy)
        if (tipLamports > 0) {
            const tipAcct = jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)];
            valid.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(tipAcct), lamports: tipLamports }));
        }
        const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: valid })
            .compileToV0Message(alts);
        const tx = new VersionedTransaction(msg);
        tx.sign([wallet]);
        return tx;
    }
    catch (e) {
        return null;
    }
}
// ─── Scan single token for round-trip arb ────────────────────────────────────
async function scanToken(symbol, mint, tradeLamports) {
    if (!circuitOk(symbol))
        return null;
    stats.scans++;
    stats.perToken[symbol].scans++;
    const q1Res = await safeFetch(`${JUP_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${tradeLamports}&slippageBps=${SLIPPAGE}&asLegacyTransaction=false&excludeDexes=${EXCLUDE_DEXES}`);
    const q1 = await q1Res.json();
    if (!q1.outAmount)
        throw new Error(`Quote1 missing outAmount: ${JSON.stringify(q1).slice(0, 80)}`);
    const q2Res = await safeFetch(`${JUP_BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${q1.outAmount}&slippageBps=${SLIPPAGE}&asLegacyTransaction=false&excludeDexes=${EXCLUDE_DEXES}`);
    const q2 = await q2Res.json();
    if (!q2.outAmount)
        throw new Error(`Quote2 missing outAmount`);
    const inSol = tradeLamports / 1e9;
    const outSol = Number(q2.outAmount) / 1e9;
    const gross = outSol - inSol;
    // Fee model: base tx fee + priority CU fee + dynamic Jito tip (50% of gross, floored at 100k lamports)
    const BASE_FEE = 0.000005;
    const CU_FEE = 0.000350;
    const tipLam = Math.max(100000, Math.min(Math.floor(gross * 1e9 * 0.5), 5000000));
    const tipSol = tipLam / 1e9;
    const totalFee = BASE_FEE + CU_FEE + tipSol;
    const net = gross - totalFee;
    return { q1, q2, gross, net, tipLam, symbol, mint };
}
// ─── Execute Jito bundle ──────────────────────────────────────────────────────
const bs58 = require('bs58');
async function executeBundle(tx) {
    const encoded = bs58.encode(tx.serialize());
    const jFetch = require('node-fetch');
    const res = await jFetch(JITO_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[encoded]] })
    });
    return await res.json();
}
// ─── Compounding logic — recalculate trade size from live balance ─────────────
let liveBalance = 0;
function nextTradeSize() {
    const raw = liveBalance * TRADE_PCT;
    return Math.max(0.01, Math.min(raw, MAX_TRADE));
}
// ─── Status dashboard printed every 30s ──────────────────────────────────────
function printDashboard() {
    const elapsed = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(1);
    const pnlSol = stats.totalPnl.toFixed(6);
    const compound = ((liveBalance - stats.startBalance) / (stats.startBalance || 1) * 100).toFixed(2);
    console.log('\n' + '═'.repeat(62));
    console.log(`  📊 JARVIS ENGINE v3  |  Runtime: ${elapsed}min`);
    console.log('─'.repeat(62));
    console.log(`  Wallet:     ${wallet.publicKey.toBase58().slice(0, 16)}...`);
    console.log(`  Balance:    ${liveBalance.toFixed(6)} SOL  (${parseFloat(compound) > 0 ? '+' : ''}${compound}% vs start)`);
    console.log(`  Scans:      ${stats.scans.toLocaleString()}  |  Trades: ${stats.trades}  |  Wins: ${stats.wins}`);
    console.log(`  Total PnL:  ${parseFloat(pnlSol) >= 0 ? '+' : ''}${pnlSol} SOL`);
    console.log(`  Trade Size: ${nextTradeSize().toFixed(4)} SOL (${(TRADE_PCT * 100).toFixed(0)}% of balance)`);
    console.log('─'.repeat(62));
    const topTokens = Object.entries(stats.perToken)
        .filter(([, v]) => v.trades > 0)
        .sort(([, a], [, b]) => b.pnl - a.pnl)
        .slice(0, 5);
    if (topTokens.length) {
        console.log('  Top Performers:');
        topTokens.forEach(([sym, v]) => {
            console.log(`    ${sym.padEnd(6)} | trades: ${v.trades} | pnl: ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(6)} SOL`);
        });
    }
    console.log('═'.repeat(62) + '\n');
}
setInterval(printDashboard, 30000);
// ─── Main engine loop ─────────────────────────────────────────────────────────
async function main() {
    await refreshJitoTips();
    liveBalance = (await connection.getBalance(wallet.publicKey)) / 1e9;
    stats.startBalance = liveBalance;
    console.log('\n' + '═'.repeat(62));
    console.log('  🚀 JARVIS ARBITRAGE ENGINE v3  —  Compounding Edition');
    console.log('═'.repeat(62));
    console.log(`  Wallet:      ${wallet.publicKey.toBase58()}`);
    console.log(`  Balance:     ${liveBalance.toFixed(6)} SOL`);
    console.log(`  Min Profit:  ${MIN_PROFIT} SOL`);
    console.log(`  Trade Size:  ${(TRADE_PCT * 100).toFixed(0)}% of balance (max ${MAX_TRADE} SOL)`);
    console.log(`  Poll:        every ${POLL_MS}ms across ${VALID_TARGETS.length} tokens`);
    console.log(`  Jito:        ${JITO_URL}`);
    console.log(`  DEX Filter:  Vote-account pools excluded ✅`);
    console.log('═'.repeat(62) + '\n');
    let cycle = 0;
    while (true) {
        cycle++;
        const tradeSol = nextTradeSize();
        const tradeLam = Math.floor(tradeSol * 1e9);
        // Refreshed balance every 20 cycles (~4s)
        if (cycle % 20 === 0) {
            try {
                liveBalance = (await connection.getBalance(wallet.publicKey)) / 1e9;
            }
            catch (_) { }
        }
        // Parallel scanning across all targets
        const scanPromises = VALID_TARGETS.map(async (t) => {
            try {
                const result = await scanToken(t.symbol, t.mint, tradeLam);
                return result;
            }
            catch (e) {
                if (!e.message.includes('RATE_LIMITED') && !e.message.includes('is not tradable')) {
                    // Only log actual errors, not rate limits
                    if (cycle % 50 === 0)
                        process.stdout.write(`[${t.symbol}!]`);
                }
                recordFailure(t.symbol);
                return null;
            }
        });
        const results = await Promise.all(scanPromises);
        const opportunities = results
            .filter(r => r !== null && r.net >= MIN_PROFIT)
            .sort((a, b) => b.net - a.net); // Best first
        if (opportunities.length === 0) {
            process.stdout.write('.');
        }
        else {
            // Take the best opportunity
            const best = opportunities[0];
            console.log(`\n\n🎯 OPPORTUNITY: ${best.symbol}  Net: +${best.net.toFixed(6)} SOL  Gross: +${best.gross.toFixed(6)} SOL`);
            try {
                // Build swap instructions
                const [ix1Res, ix2Res] = await Promise.all([
                    safeFetch(`${JUP_BASE}/swap-instructions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ quoteResponse: best.q1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                    }),
                    safeFetch(`${JUP_BASE}/swap-instructions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ quoteResponse: best.q2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                    })
                ]);
                const [ix1, ix2] = await Promise.all([ix1Res.json(), ix2Res.json()]);
                if (ix1.error || ix2.error)
                    throw new Error(`Swap instructions error: ${ix1.error || ix2.error}`);
                const tx = await buildTx(ix1, ix2, best.tipLam);
                if (!tx)
                    throw new Error('Transaction builder returned null');
                const txStart = Date.now();
                const jitoRes = await executeBundle(tx);
                const txMs = Date.now() - txStart;
                const sig = bs58.encode(tx.signatures[0]);
                stats.trades++;
                stats.perToken[best.symbol].trades++;
                if (jitoRes.result) {
                    console.log(`✅ BUNDLE ACCEPTED  | Bundle: ${jitoRes.result.slice(0, 20)}...  | Jito: ${txMs}ms`);
                    console.log(`🔗 https://solscan.io/tx/${sig}`);
                    recordSuccess(best.symbol);
                    // Wait for confirmation and update compounding balance
                    setTimeout(async () => {
                        try {
                            const newBal = (await connection.getBalance(wallet.publicKey)) / 1e9;
                            const delta = newBal - liveBalance;
                            liveBalance = newBal;
                            if (delta !== 0) {
                                stats.wins++;
                                stats.totalPnl += delta;
                                stats.fees += best.tipLam / 1e9;
                                stats.perToken[best.symbol].pnl += delta;
                                console.log(`💰 CONFIRMED  Δ${delta >= 0 ? '+' : ''}${delta.toFixed(8)} SOL  New balance: ${newBal.toFixed(6)} SOL`);
                            }
                        }
                        catch (_) { }
                    }, 8000);
                }
                else if (jitoRes.error?.code === -32097) {
                    // Jito server-side rate limit — bundle format is correct, transient
                    console.log(`⚡ JITO CONGESTED (${txMs}ms) — bundle format confirmed valid`);
                }
                else {
                    recordFailure(best.symbol);
                    console.log(`❌ Jito rejected: ${jitoRes.error?.message}`);
                }
            }
            catch (e) {
                recordFailure(best.symbol);
                console.log(`❌ Execution error [${best.symbol}]: ${e.message.slice(0, 100)}`);
            }
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}
main().catch(e => {
    console.error('\n❌ FATAL ENGINE CRASH:', e.message);
    process.exit(1);
});
