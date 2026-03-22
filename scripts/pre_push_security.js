#!/usr/bin/env node
/**
 * PRE-PUSH SECURITY SCRUB
 * ════════════════════════════════════════════════════════════
 * Run automatically before every git push via pre-push hook.
 * Also runnable manually: node scripts/pre_push_security.js
 *
 * - SCRUBS hardcoded credentials from source files
 * - BLOCKS push if any secrets remain after scrub
 * - LOGS every action for audit trail
 * ════════════════════════════════════════════════════════════
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Known secrets → safe placeholder replacements ───────────────────────────
const SCRUB_RULES = [
  // Helius — both old and new keys (rotate, always use env var)
  { find: /https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-f0-9-]{36}/g,
    rep:  'https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY' },
  { find: /wss:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-f0-9-]{36}/g,
    rep:  'wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY' },
  { find: /https:\/\/rpc\.helius\.xyz\/\?api-key=[a-f0-9-]{36}/g,
    rep:  'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY' },
  // Chainstack
  { find: /https:\/\/solana-mainnet\.core\.chainstack\.com\/[a-z0-9]{20,}/g,
    rep:  'https://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY' },
  { find: /https:\/\/yellowstone-solana-mainnet\.core\.chainstack\.com[^\s"']*/g,
    rep:  'https://yellowstone-solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_ENDPOINT' },
  // Bags keys (any format)
  { find: /bags_prod_[A-Za-z0-9_-]{10,}/g, rep: 'process.env.BAGS_API_KEY' },
];

// ── Exact secret patterns that BLOCK the push if found ──────────────────────
const BLOCK_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,  // UUID API keys
  /bags_prod_[A-Za-z0-9_-]{10,}/,                                       // Bags keys
  /\btz5h4vi5\b/,                                                        // Chainstack token fragment
  // Wallet keypair arrays (64 numbers)
  /\[\s*(\d+\s*,\s*){63}\d+\s*\]/,
];

// False-positive overrides (safe UUIDs / known-public values)
const SAFE_PATTERNS = [
  'YOUR_HELIUS_API_KEY', 'YOUR_JUPITER_API_KEY', 'YOUR_CHAINSTACK_KEY',
  'YOUR_CHAINSTACK_ENDPOINT', 'YOUR_NGROK_AUTH_TOKEN',
  '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS', // $PCP mint (public)
  'TxW2V7LxCr9HtPW1cCn1gAwmgpP4eKCci9tJVw2rGDQ',  // fee account (public)
  'AnMHX3iv8NToB2enn2xFQG143vk61TVecujFosiVJe38',  // referral project (public)
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',            // test/mock UUIDs
  '3155a25e-0542-4a02-b4da-a9343131394d',            // test UUID
  'bb328d29-b99e-4d05-98f9-a610ce470001',            // test UUID
  '1a65cb8f-b1f4-46cd-9ed3-3f2b3ac2e30d',            // test UUID
];

// File extensions that get BLOCK-checked (only source files, not data/logs)
const BLOCK_EXTS = new Set(['.js', '.ts', '.tsx', '.mjs', '.cjs']);

const SCRUB_EXTS  = new Set(['.js', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIRS   = new Set(['node_modules', '.git', 'target', '.next', 'dist', 'build', '.next_build', '.venv', '__pycache__']);
// Also skip data/log files from block checks (UUIDs are normal there)
const SKIP_BLOCK  = new Set(['.json', '.log', '.txt', '.gz', '.csv']);
const SKIP_BINARY = new Set(['.png','.jpg','.jpeg','.gif','.mp4','.webm','.webp','.gz','.zip','.tar','.mp3','.wav','.ico','.woff','.woff2','.ttf','.eot','.pdf','.lock','.pyc']);

let scrubbed = 0;
const violations = [];

function isSafe(match) {
  return SAFE_PATTERNS.some(s => match.includes(s));
}

function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_BINARY.has(ext)) return;

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return; }
  if (!content || content.length > 500_000) return;

  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');

  // Skip the .env file itself (gitignored, keys must stay there)
  if (rel === '.env' || rel.endsWith('/.env')) return;
  // Skip .env.example (intentional placeholders)
  if (rel.endsWith('.env.example')) return;
  // Skip the pre-push script itself
  if (rel === 'scripts/pre_push_security.js') return;

  let changed = false;
  let newContent = content;

  // Apply scrub rules to source files
  if (SCRUB_EXTS.has(ext)) {
    for (const { find, rep } of SCRUB_RULES) {
      const before = newContent;
      newContent = newContent.replace(find, rep);
      if (newContent !== before) changed = true;
    }
    if (changed) {
      fs.writeFileSync(filePath, newContent);
      console.log(`  ✂  SCRUBBED: ${rel}`);
      scrubbed++;
    }
  }

  // Check remaining content for block patterns — source files only
  if (BLOCK_EXTS.has(ext) || !SKIP_BLOCK.has(ext)) {
    for (const pat of BLOCK_PATTERNS) {
      // Skip keypair check on non-source files
      if (pat.toString().includes('{63}') && !SCRUB_EXTS.has(ext)) continue;
      const match = newContent.match(pat);
      if (match && !isSafe(match[0])) {
        violations.push({ file: rel, pattern: pat.toString().slice(0, 50), match: match[0].slice(0, 40) });
      }
    }
  }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = path.join(dir, e);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) walk(full);
    else processFile(full);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log('🔐 Running pre-push security scrub...');
walk(ROOT);
console.log(`   Scrubbed ${scrubbed} file(s).`);

if (violations.length > 0) {
  console.error('\n🚨 PUSH BLOCKED — SECRETS STILL PRESENT:');
  for (const v of violations) {
    console.error(`   ${v.file}: ${v.match}`);
  }
  console.error('\nFix these before pushing. Do NOT commit credentials.\n');
  process.exit(1); // non-zero exit blocks the push via git hook
} else {
  console.log('   ✅ No secrets detected. Push proceeding.\n');
  process.exit(0);
}
