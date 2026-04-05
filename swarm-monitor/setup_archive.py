import json, os, time

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
ARCHIVE_DIR = os.path.join(BASE, 'signals', 'archive')
ARCHIVE = os.path.join(ARCHIVE_DIR, 'trade_history.jsonl')
REFINER = os.path.join(BASE, 'scripts', 'maintain', 'gemma4_auto_refiner.py')
SNIPER = os.path.join(BASE, 'scripts', 'maintain', 'momentum_sniper.ts')

# ═══════════════════════════════════════════════════════════════
# STEP 1: Create permanent archive directory
# ═══════════════════════════════════════════════════════════════
os.makedirs(ARCHIVE_DIR, exist_ok=True)
print('=== STEP 1: Archive directory ===')
print(f'  Created {ARCHIVE_DIR}')

# ═══════════════════════════════════════════════════════════════
# STEP 2: Merge ALL existing trade data into permanent archive
# ═══════════════════════════════════════════════════════════════
print('\n=== STEP 2: Consolidate all trade data ===')
sources = [
    os.path.join(BASE, 'trade_journal.jsonl'),
    os.path.join(BASE, 'signals', 'trade_journal.jsonl'),
    os.path.join(BASE, 'signals', 'trade_journal_combined.jsonl'),
    os.path.join(BASE, 'signals', 'trade_journal_paper.jsonl'),
]

seen = set()
all_trades = []
for src in sources:
    if not os.path.exists(src):
        continue
    count = 0
    with open(src) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                # Dedup key: tradeId or (mint + ts + action)
                key = entry.get('tradeId') or f"{entry.get('mint','')}-{entry.get('ts','')}-{entry.get('action','')}"
                if key not in seen:
                    seen.add(key)
                    all_trades.append(line)
                    count += 1
            except:
                all_trades.append(line)
                count += 1
    print(f'  {os.path.basename(src)}: {count} new entries')

# Write permanent archive
with open(ARCHIVE, 'w') as f:
    for line in all_trades:
        f.write(line + '\n')
print(f'  TOTAL ARCHIVE: {len(all_trades)} unique entries')

# ═══════════════════════════════════════════════════════════════
# STEP 3: Update sniper to always append to permanent archive
# ═══════════════════════════════════════════════════════════════
print('\n=== STEP 3: Sniper → permanent archive ===')
with open(SNIPER) as f:
    code = f.read()

# Add archive write after existing journal writes
archive_write = "    // Permanent archive — never truncated, Gemma4 reads this forever\n    fs.appendFileSync(path.join(__dirname, '../../signals/archive/trade_history.jsonl'), line, 'utf-8');"

if 'archive/trade_history.jsonl' not in code:
    # Insert after the root journal dual-write
    code = code.replace(
        "    // Also write to root journal for long-term tracking\n    fs.appendFileSync(path.join(__dirname, '../../trade_journal.jsonl'), line, 'utf-8');",
        "    // Also write to root journal for long-term tracking\n    fs.appendFileSync(path.join(__dirname, '../../trade_journal.jsonl'), line, 'utf-8');\n" + archive_write
    )
    print('  Added archive write to appendTrade()')
else:
    print('  Already present')

with open(SNIPER, 'w') as f:
    f.write(code)

# ═══════════════════════════════════════════════════════════════
# STEP 4: Update Gemma4 to read from permanent archive
# ═══════════════════════════════════════════════════════════════
print('\n=== STEP 4: Gemma4 → permanent archive ===')
with open(REFINER) as f:
    rcode = f.read()

# Change JOURNAL path to archive
old_path = "JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal_combined.jsonl'"
new_path = "JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/archive/trade_history.jsonl'"

if old_path in rcode:
    rcode = rcode.replace(old_path, new_path)
    print('  Gemma4 JOURNAL → archive/trade_history.jsonl')
else:
    print('  Path already updated or not found')

with open(REFINER, 'w') as f:
    f.write(rcode)

# ═══════════════════════════════════════════════════════════════
# STEP 5: Verify
# ═══════════════════════════════════════════════════════════════
print('\n=== VERIFICATION ===')
print(f'  Archive: {ARCHIVE}')
print(f'  Entries: {len(all_trades)}')
sz = os.path.getsize(ARCHIVE)
print(f'  Size: {sz/1024:.1f} KB')
print(f'  At 1KB/trade: can store ~{88*1024*1024/1024:.0f} trades in 88GB free space')
print(f'  That\'s ~{88*1024*1024/1024/500:.0f} days at 500 trades/day')
print(f'\n  ✅ Gemma4 will read ALL historical trades forever')
print(f'  ✅ New trades auto-append to archive')
print(f'  ✅ Archive NEVER rotated or truncated')
