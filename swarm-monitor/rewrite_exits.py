"""
Complete rewrite of the exit logic in momentum_sniper.ts:
1. Remove ALL Apex force-sell logic
2. Hard TP/SL only - no Apex dependency  
3. Zero priority fees for all trades (buy + sell)
4. Cap slippage
"""

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    lines = f.readlines()

new_lines = []
i = 0
fixes = []
while i < len(lines):
    line = lines[i]
    
    # 1. Replace the ENTIRE Apex Predator block
    if '── APEX PREDATOR: Asynchronous Conviction Rejection' in line:
        new_lines.append('    // ── APEX DISABLED — hard TP/SL only ────────────\n')
        new_lines.append('    const pub = RedisBus.getPublisher();\n')
        new_lines.append('    let isHighConviction = true;\n')
        new_lines.append('    let apexCancelReason = "";\n')
        new_lines.append('    let apexRedFlags = -1;\n')
        while i < len(lines):
            if 'catch(e)' in lines[i]:
                i += 1
                if i < len(lines) and '}' in lines[i]:
                    i += 1
                break
            i += 1
        fixes.append('Apex force-sell block removed')
        continue
    
    # 2. Remove $4M mcap force-exit entirely
    if '$4M Market Cap Check' in line:
        new_lines.append('    // ── $4M mcap check: DISABLED ───────\n')
        while i < len(lines) and 'Triple-Layer Hard Exit' not in lines[i]:
            i += 1
        fixes.append('$4M mcap block removed')
        continue
    
    # 3. Fix sell priority fees — ALL sells use 5000 lamports
    if 'const priorityFee = tpHit' in line:
        new_lines.append('      const priorityFee = 5_000; // 0.000005 SOL\n')
        i += 1
        fixes.append('Sell fee: 5K lamports')
        continue
    
    # 4. Fix buy priority fee — line 581
    if 'executeSwap(quote, 250_000)' in line:
        new_lines.append(line.replace('250_000', '5_000'))
        i += 1
        fixes.append('Buy fee: 5K lamports (was 250K)')
        continue
    
    # 5. Fix default executeSwap tip
    if 'tipLamports = 10000' in line:
        new_lines.append(line.replace('tipLamports = 10000', 'tipLamports = 5000'))
        i += 1
        fixes.append('Default tip: 5K lamports')
        continue
    
    # 6. Fix emergency slippage: cap at 15%
    if 'slippageBps = isEmergencyExit ? 5000' in line:
        new_lines.append('      const slippageBps = isEmergencyExit ? 1500 : 500; // 15% max, 5% normal\n')
        i += 1
        fixes.append('Slippage capped: 15% emergency, 5% normal (was 50%/10%)')
        continue
    
    # 7. Remove Apex SL widening
    if 'APEX: Widen initial Stop Loss' in line:
        new_lines.append('    // Apex SL widening: DISABLED\n')
        # Skip the next 2 lines (the if block)
        i += 1
        while i < len(lines) and '}' not in lines[i]:
            i += 1
        if i < len(lines):
            i += 1  # skip closing }
        fixes.append('Apex SL widening removed')
        continue
    
    new_lines.append(line)
    i += 1

with open(path, 'w') as f:
    f.writelines(new_lines)

for f in fixes:
    print(f'  ✅ {f}')
print(f'\nTotal fixes applied: {len(fixes)}')
