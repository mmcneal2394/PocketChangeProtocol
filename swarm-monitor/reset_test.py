import json

# Reset consecutive losses and check state
path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json'
try:
    with open(path) as f:
        d = json.load(f)
    
    stats = d.get('stats', {})
    print('=== STORE STATE ===')
    print(f'  Positions: {len(d.get("positions", []))}')
    print(f'  Blacklist: {len(d.get("blacklist", []))}')
    print(f'  Stats: {json.dumps(stats, indent=4)}')
    
    # Reset consecutive losses for fresh test
    if 'consecutiveLosses' in stats:
        stats['consecutiveLosses'] = 0
    if 'pausedUntil' in stats:
        stats['pausedUntil'] = 0
    d['stats'] = stats
    
    # Clear blacklist for fresh test
    d['blacklist'] = []
    d['positions'] = []
    
    with open(path, 'w') as f:
        json.dump(d, f, indent=2)
    print('\nReset: consecutiveLosses=0, pausedUntil=0, blacklist cleared, positions cleared')
except Exception as e:
    print(f'Error: {e}')

# Verify journal write path
journal = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl'
import os
print(f'\nJournal exists: {os.path.exists(journal)}')
print(f'Journal size: {os.path.getsize(journal) if os.path.exists(journal) else 0} bytes')

# Verify Gemma4 recommendations
recs = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/gemma4_recommendations.json'
if os.path.exists(recs):
    with open(recs) as f:
        r = json.load(f)
    print(f'\nGemma4 recommendations loaded:')
    print(f'  Key insight: {r.get("key_insight","")}')
    print(f'  Confidence: {r.get("confidence",0)}%')
    print(f'  Filters: {json.dumps(r.get("recommended_filters",{}), indent=4)}')
