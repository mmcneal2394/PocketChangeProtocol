/**
 * 5-Minute Live Confirmation Test v2 — Speed Metrics Edition
 * ===========================================================
 * - Same 0.01 SOL round-trips via Jupiter Ultra
 * - Reports per-leg timing breakdown: quote + sign + execute
 * - Uses pre-raced blockhash from Helius + Chainstack
 * - Confirms every TX on Solscan
 */
require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');
const nodeFetch = require('node-fetch');
const bs58 = require('bs58');
const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const CHAIN_RPC = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const KEY = process.env.JUPITER_API_KEY || '';
const BASE = 'https://lite-api.jup.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const TRADE_SOL = 0.01;
const TRADE_LAM = Math.floor(TRADE_SOL * 1e9);
const RUN_MS = 5 * 60 * 1000;
const PAUSE_MS = 14000; // 14s between trades (API cooldown)
const SLIP = 50; // 0.5% slippage
const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,' +
    'VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');
const TOKENS = [
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
    { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
    { symbol: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
];
// ── Dual-RPC blockhash race ──────────────────────────────────────────────────
async function getBlockhashRace() {
    const start = Date.now();
    const race = await Promise.race([
        nodeFetch(HELIUS_RPC, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'processed' }] })
        }).then(r => r.json()).then(d => ({ source: 'Helius', blockhash: d.result.value.blockhash })),
        nodeFetch(CHAIN_RPC, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'processed' }] })
        }).then(r => r.json()).then(d => ({ source: 'Chainstack', blockhash: d.result.value.blockhash })),
    ]);
    return { ...race, ms: Date.now() - start };
}
const connection = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const walletRaw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletRaw));
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function jupFetch(path, opts = {}) {
    const res = await nodeFetch(`${BASE}${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, ...(opts.headers || {}) }
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`${res.status}: ${text.slice(0, 150)}`);
    return JSON.parse(text);
}
async function executeUltraLeg(inputMint, outputMint, amount) {
    const t0 = Date.now();
    const order = await jupFetch(`/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIP}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`);
    const tOrder = Date.now() - t0;
    if (order.error)
        throw new Error(`Order: ${JSON.stringify(order).slice(0, 100)}`);
    const tSign0 = Date.now();
    const buf = Buffer.from(order.transaction, 'base64');
    let tx;
    try {
        tx = VersionedTransaction.deserialize(buf);
        tx.sign([wallet]);
    }
    catch (_) {
        tx = Transaction.from(buf);
        tx.sign(wallet);
    }
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const sig = bs58.encode(tx.signatures[0]);
    const tSign = Date.now() - tSign0;
    const tExec0 = Date.now();
    const exec = await jupFetch('/ultra/v1/execute', {
        method: 'POST',
        body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId })
    });
    const tExec = Date.now() - tExec0;
    return {
        status: exec.status,
        sig,
        outAmount: order.outAmount,
        error: exec.error,
        timing: { order: tOrder, sign: tSign, exec: tExec, total: tOrder + tSign + tExec }
    };
}
async function roundTrip(token) {
    const bh = await getBlockhashRace();
    console.log(`  🔑 Blockhash: ${bh.source} won (${bh.ms}ms)`);
    const t0 = Date.now();
    process.stdout.write(`  → LEG1 SOL→${token.symbol}... `);
    const leg1 = await executeUltraLeg(SOL, token.mint, TRADE_LAM);
    if (leg1.status !== 'Success')
        throw new Error(`Leg1 failed [${leg1.status}]: ${leg1.error}`);
    console.log(`✅ ${leg1.timing.total}ms  [order:${leg1.timing.order}ms exec:${leg1.timing.exec}ms]`);
    console.log(`     ↳ https://solscan.io/tx/${leg1.sig}`);
    await sleep(2500);
    const out = parseInt(leg1.outAmount || '0');
    process.stdout.write(`  → LEG2 ${token.symbol}→SOL... `);
    const leg2 = await executeUltraLeg(token.mint, SOL, out);
    if (leg2.status !== 'Success')
        throw new Error(`Leg2 failed [${leg2.status}]: ${leg2.error}`);
    console.log(`✅ ${leg2.timing.total}ms  [order:${leg2.timing.order}ms exec:${leg2.timing.exec}ms]`);
    console.log(`     ↳ https://solscan.io/tx/${leg2.sig}`);
    const roundMs = Date.now() - t0;
    return { sig1: leg1.sig, sig2: leg2.sig, roundMs, symbol: token.symbol, timing: { leg1: leg1.timing, leg2: leg2.timing, bh: bh.ms, bhSource: bh.source } };
}
async function main() {
    const balBefore = (await connection.getBalance(wallet.publicKey)) / 1e9;
    const endTime = Date.now() + RUN_MS;
    const trades = [];
    const failed = [];
    let tokenIdx = 0;
    let round = 0;
    console.log('\n' + '═'.repeat(66));
    console.log('  ⚡ 5-MIN LIVE TEST v2  —  Speed Metrics + Dual-RPC');
    console.log('═'.repeat(66));
    console.log(`  Wallet:     ${wallet.publicKey.toBase58()}`);
    console.log(`  Balance:    ${balBefore.toFixed(6)} SOL`);
    console.log(`  Trade:      ${TRADE_SOL} SOL per round-trip`);
    console.log(`  Blockhash:  Helius vs Chainstack race (fastest wins)`);
    console.log(`  Broadcast:  Jupiter Ultra /execute (managed propagation)`);
    console.log(`  Duration:   5 minutes`);
    console.log('═'.repeat(66) + '\n');
    while (Date.now() < endTime) {
        round++;
        const remaining = Math.round((endTime - Date.now()) / 1000);
        const token = TOKENS[tokenIdx++ % TOKENS.length];
        console.log(`\n[Round ${round}] ${token.symbol}  |  ~${remaining}s left`);
        const t0 = Date.now();
        try {
            const result = await roundTrip(token);
            trades.push(result);
            console.log(`  ✅ Round-trip: ${result.roundMs}ms total (BH: ${result.timing.bh}ms via ${result.timing.bhSource})`);
        }
        catch (e) {
            const msg = e.message.slice(0, 120);
            failed.push({ round, symbol: token.symbol, error: msg, ms: Date.now() - t0 });
            console.log(`  ❌ ${msg}`);
        }
        const wait = Math.min(PAUSE_MS, endTime - Date.now());
        if (wait > 1000) {
            process.stdout.write(`  ⏳ ${Math.round(wait / 1000)}s cooldown...`);
            await sleep(wait);
            process.stdout.write(`\r  ✓ ready                    \n`);
        }
    }
    // ── Speed Statistics ──────────────────────────────────────────────────────
    const balAfter = (await connection.getBalance(wallet.publicKey)) / 1e9;
    const delta = balAfter - balBefore;
    const avgRound = trades.length ? Math.round(trades.reduce((s, t) => s + t.roundMs, 0) / trades.length) : 0;
    const avgLeg1 = trades.length ? Math.round(trades.reduce((s, t) => s + t.timing.leg1.total, 0) / trades.length) : 0;
    const avgLeg2 = trades.length ? Math.round(trades.reduce((s, t) => s + t.timing.leg2.total, 0) / trades.length) : 0;
    const avgBh = trades.length ? Math.round(trades.reduce((s, t) => s + t.timing.bh, 0) / trades.length) : 0;
    const heliusWin = trades.filter(t => t.timing.bhSource === 'Helius').length;
    const chainWin = trades.filter(t => t.timing.bhSource === 'Chainstack').length;
    console.log('\n' + '═'.repeat(66));
    console.log('  📊 5-MINUTE TEST REPORT');
    console.log('═'.repeat(66));
    console.log(`  Balance:     ${balBefore.toFixed(6)} → ${balAfter.toFixed(6)} SOL  (${delta >= 0 ? '+' : ''}${delta.toFixed(6)} SOL)`);
    console.log(`  Rounds:      ${round}  |  Success: ${trades.length}  |  Failed: ${failed.length}`);
    console.log(`  Cost/round:  ~${(Math.abs(delta) / Math.max(trades.length, 1)).toFixed(4)} SOL (fees+slippage)`);
    console.log('─'.repeat(66));
    console.log(`  ⏱️  SPEED METRICS:`);
    console.log(`  Avg round-trip:   ${avgRound}ms`);
    console.log(`  Avg LEG1:         ${avgLeg1}ms`);
    console.log(`  Avg LEG2:         ${avgLeg2}ms`);
    console.log(`  Avg blockhash:    ${avgBh}ms  (Helius won: ${heliusWin}  Chainstack: ${chainWin})`);
    console.log('─'.repeat(66));
    if (trades.length) {
        console.log(`\n  ✅ CONFIRMED TRANSACTIONS:`);
        trades.forEach((t, i) => {
            console.log(`  [${i + 1}] ${t.symbol}  ${t.roundMs}ms  BH:${t.timing.bh}ms(${t.timing.bhSource})`);
            console.log(`       LEG1: https://solscan.io/tx/${t.sig1}`);
            console.log(`       LEG2: https://solscan.io/tx/${t.sig2}`);
        });
    }
    if (failed.length) {
        console.log(`\n  ❌ FAILURES:`);
        failed.forEach(f => console.log(`  [${f.round}] ${f.symbol}  ${f.ms}ms  ${f.error}`));
    }
    console.log('\n' + '═'.repeat(66) + '\n');
    fs.writeFileSync('./live5min_v2_summary.json', JSON.stringify({ trades, failed, stats: { avgRound, avgLeg1, avgLeg2, avgBh, heliusWin, chainWin, delta } }, null, 2));
    console.log('  📄 Summary → live5min_v2_summary.json');
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
