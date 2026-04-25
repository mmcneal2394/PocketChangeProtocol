"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const { spawnSync } = require('child_process');
const GMGN_CLI_BIN = '/usr/bin/gmgn-cli';

let gmgnAvailable = false; // VPS IP blocked;
let gmgnLastError = '';

function isGmgnReady() { return gmgnAvailable; }
function getGmgnError() { return gmgnLastError; }

function runGmgnCli_swap(args) {
  try {
    const argv = args.split(/\s+/).filter(Boolean);
    const res = spawnSync(GMGN_CLI_BIN, [...argv, '--raw'], {
      cwd: process.cwd(),
      timeout: 30000,
      encoding: 'utf-8',
      shell: true,
      env: { ...process.env },
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const msg = String(res.stderr || res.stdout || '').trim().split('\n')[0];
      throw new Error(msg || 'gmgn-cli exited ' + res.status);
    }
    return JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    const errMsg = (e.message || '').split('\n')[0];
    console.error('[GMGN-SWAP] CLI error: ' + errMsg);
    if (errMsg.includes('IP_BLOCKED') || errMsg.includes('403')) {
      gmgnAvailable = false;
      gmgnLastError = 'IP_BLOCKED';
      console.warn('[GMGN-SWAP] VPS IP blocked by GMGN — falling back to Jupiter');
    }
    return null;
  }
}

async function executeSwapGmgn(inputMint, outputMint, amountLamports, slippagePct, conditionOrders) {
  if (gmgnLastError === 'IP_BLOCKED') { return null; } // Skip — VPS IP blocked
  slippagePct = slippagePct || 0.05;
  const walletAddr = process.env.WALLET_PUBLIC_KEY || '7c5JGzkgRXePGSjSDoTj71qiAVwDTWeUqHyQyyP1krzD';

  let cmd = 'swap --chain sol --from ' + walletAddr +
    ' --input-token ' + inputMint + ' --output-token ' + outputMint +
    ' --amount ' + amountLamports + ' --slippage ' + slippagePct +
    ' --anti-mev --priority-fee 0.00005';

  if (conditionOrders && conditionOrders.length > 0) {
    cmd += " --condition-orders '" + JSON.stringify(conditionOrders) + "'";
  }

  console.log('[GMGN-SWAP] Executing: ' + cmd.slice(0, 120) + '...');
  const result = runGmgnCli_swap(cmd);

  if (result && result.data && result.data.hash) {
    gmgnAvailable = true;
    console.log('[GMGN-SWAP] TX hash: ' + result.data.hash);
    return result.data.hash;
  }
  if (result && result.data && result.data.order_id) {
    gmgnAvailable = true;
    console.log('[GMGN-SWAP] Order ID: ' + result.data.order_id);
    return result.data.order_id;
  }

  if (gmgnLastError === 'IP_BLOCKED') {
    console.warn('[GMGN-SWAP] Skipping repeated blocked route until GMGN access changes');
    return null;
  }

  gmgnLastError = JSON.stringify((result && result.msg) || (result && result.error) || 'unknown').slice(0, 100);
  console.log('[GMGN-SWAP] Failed: ' + gmgnLastError);
  return null;
}

function getGmgnTokenPrice(mint) {
  try {
    const res = spawnSync(GMGN_CLI_BIN, ['token', 'info', '--chain', 'sol', '--address', mint, '--raw'], {
      timeout: 10000, encoding: 'utf-8', shell: true, env: { ...process.env },
    });
    if (res.status === 0) {
      const parsed = JSON.parse(String(res.stdout).trim());
      const price = parseFloat((parsed.data && parsed.data.price) || (parsed.data && parsed.data.token && parsed.data.token.price) || '0');
      if (price > 0) return price;
    }
  } catch(e) {}
  return null;
}

function checkGmgnSecurity(mint) {
  try {
    const res = spawnSync(GMGN_CLI_BIN, ['token', 'security', '--chain', 'sol', '--address', mint, '--raw'], {
      timeout: 10000, encoding: 'utf-8', shell: true, env: { ...process.env },
    });
    if (res.status === 0) {
      const parsed = JSON.parse(String(res.stdout).trim());
      const sec = parsed.data || {};
      if (sec.is_honeypot) return { safe: false, reason: 'HONEYPOT' };
      if (sec.mint_authority && sec.mint_authority !== 'null') return { safe: false, reason: 'MINT_AUTH' };
      if (sec.freeze_authority && sec.freeze_authority !== 'null') return { safe: false, reason: 'FREEZE_AUTH' };
      if (parseFloat(sec.top10_holder_rate || '0') > 0.8) return { safe: false, reason: 'TOP10_CONCENTRATED' };
      return { safe: true, reason: 'PASSED' };
    }
  } catch(e) {}
  return { safe: true, reason: 'CHECK_UNAVAILABLE' };
}

exports.isGmgnReady = isGmgnReady;
exports.getGmgnError = getGmgnError;
exports.runGmgnCli_swap = runGmgnCli_swap;
exports.executeSwapGmgn = executeSwapGmgn;
exports.getGmgnTokenPrice = getGmgnTokenPrice;
exports.checkGmgnSecurity = checkGmgnSecurity;
