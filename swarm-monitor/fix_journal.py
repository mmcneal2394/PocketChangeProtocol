import json, os

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
ROOT_JOURNAL = os.path.join(BASE, 'trade_journal.jsonl')
SIGNALS_JOURNAL = os.path.join(BASE, 'signals', 'trade_journal.jsonl')
COMBINED = os.path.join(BASE, 'signals', 'trade_journal_combined.jsonl')
POSITIONS = os.path.join(BASE, 'signals', 'sniper_positions.json')
REFINER = os.path.join(BASE, 'scripts', 'maintain', 'gemma4_auto_refiner.py')

# Step 1: Merge journals — append root entries into signals (deduped by tradeId)
print('=== MERGING JOURNALS ===')
seen_ids = set()
combined = []

for jpath in [ROOT_JOURNAL, SIGNALS_JOURNAL]:
    if not os.path.exists(jpath):
        continue
    with open(jpath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                tid = entry.get('tradeId', '') or entry.get('ts', '')
                if tid and tid not in seen_ids:
                    seen_ids.add(tid)
                    combined.append(line)
            except:
                combined.append(line)  # keep even unparseable

with open(COMBINED, 'w') as f:
    for line in combined:
        f.write(line + '\n')

print(f'  Root journal: {sum(1 for _ in open(ROOT_JOURNAL))} entries')
print(f'  Signals journal: {sum(1 for _ in open(SIGNALS_JOURNAL))} entries')
print(f'  Combined (deduped): {len(combined)} entries')

# Step 2: Also copy session stats into the combined file as metadata
print('\n=== SESSION STATS ===')
if os.path.exists(POSITIONS):
    d = json.load(open(POSITIONS))
    stats = d.get('stats', {})
    print(f'  Wins: {stats.get("wins", 0)} | Losses: {stats.get("losses", 0)} | PnL: {stats.get("totalPnlSol", 0):.4f} SOL')
    
    # Write stats summary as a special entry
    stats_entry = {
        'type': 'SESSION_STATS',
        'wins': stats.get('wins', 0),
        'losses': stats.get('losses', 0),
        'totalPnlSol': stats.get('totalPnlSol', 0),
        'ts': __import__('time').time() * 1000,
    }
    with open(COMBINED, 'a') as f:
        f.write(json.dumps(stats_entry) + '\n')

# Step 3: Update Gemma4 refiner to read combined journal
print('\n=== UPDATING GEMMA4 REFINER ===')
with open(REFINER) as f:
    refiner_code = f.read()

# Point to combined journal and also the signals journal
old_journal = "JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl'"
new_journal = "JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal_combined.jsonl'"
if old_journal in refiner_code:
    refiner_code = refiner_code.replace(old_journal, new_journal)
    print('  Updated JOURNAL path to combined file')

with open(REFINER, 'w') as f:
    f.write(refiner_code)

# Step 4: Also make the sniper write to BOTH locations (root + signals)
# so historical data keeps accumulating
SNIPER = os.path.join(BASE, 'scripts', 'maintain', 'momentum_sniper.ts')
with open(SNIPER) as f:
    sniper_code = f.read()

# Add a second write to the root journal after the signals journal write
old_write = "    fs.appendFileSync(JOURNAL_FILE, line, 'utf-8');"
new_write = """    fs.appendFileSync(JOURNAL_FILE, line, 'utf-8');
    // Also write to root journal for long-term tracking
    fs.appendFileSync(path.join(__dirname, '../../trade_journal.jsonl'), line, 'utf-8');"""

if old_write in sniper_code and '// Also write to root journal' not in sniper_code:
    sniper_code = sniper_code.replace(old_write, new_write, 1)
    print('  Added dual-write to sniper (signals + root)')

with open(SNIPER, 'w') as f:
    f.write(sniper_code)

# Step 5: Re-merge so combined is fresh
os.system(f'cat {ROOT_JOURNAL} {SIGNALS_JOURNAL} | sort -t, -k1 > /tmp/merge_tmp.jsonl && mv /tmp/merge_tmp.jsonl {COMBINED} 2>/dev/null || true')

print('\n=== DONE ===')
print(f'  Combined journal: {COMBINED}')
print(f'  Total entries: {len(combined)}')
print(f'  Gemma4 will now read all trade history')
