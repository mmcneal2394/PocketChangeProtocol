path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Remove Apex candidate push (lines 791-803)
old_apex_push = """  // Route newly armed position to Apex Predator queue for asynchronous Forensics Sweeps
  try {
     const pub = RedisBus.getPublisher();
     await pub.rpush(REDIS_KEYS.apexCandidates, JSON.stringify({
         mint: pos.mint,
         symbol: pos.symbol,"""

# Find and remove the entire try/catch block
idx = content.find(old_apex_push)
if idx > -1:
    # Find the matching catch/closing
    end_marker = "Failed to enqueue"
    end_idx = content.find(end_marker, idx)
    if end_idx > -1:
        # Find the end of the catch block (next `}`)
        brace_end = content.find('\n\n', end_idx)
        if brace_end > -1:
            removed = content[idx:brace_end]
            content = content[:idx] + '  // Apex Predator: REMOVED — was causing force-sells\n' + content[brace_end:]
            fixes.append('Removed Apex candidate push to Redis')

# 2. Remove apexCancelReason from exit reason check
old_reason = """      const reason = apexCancelReason ? apexCancelReason
                   : forceExit        ? `FORCE_EXIT (Apex / Emergency)`"""
new_reason = """      const reason = forceExit        ? `FORCE_EXIT (Emergency)`"""
if old_reason in content:
    content = content.replace(old_reason, new_reason)
    fixes.append('Removed apexCancelReason from exit logic')

# 3. Remove apexCancelReason, apexRedFlags, isHighConviction variables
old_apex_vars = """    // ── APEX DISABLED — hard TP/SL only ────────────
    const pub = RedisBus.getPublisher();
    let isHighConviction = true;
    let apexCancelReason = "";
    let apexRedFlags = -1;"""
new_apex_vars = """    // ── Pure TP/SL exit logic ────────────
    const pub = RedisBus.getPublisher();"""
if old_apex_vars in content:
    content = content.replace(old_apex_vars, new_apex_vars)
    fixes.append('Removed Apex variables (isHighConviction, apexCancelReason, apexRedFlags)')

# 4. Remove ENGINE_FORCE_SELL subscription
old_force_sub = "  sub.subscribe(CHANNELS.ENGINE_FORCE_SELL);"
if old_force_sub in content:
    content = content.replace(old_force_sub, "  // ENGINE_FORCE_SELL: DISABLED — was causing unexpected force exits")
    fixes.append('Disabled ENGINE_FORCE_SELL Redis subscription')

# 5. Remove the ENGINE_FORCE_SELL handler
old_force_handler = "    else if (ch === CHANNELS.ENGINE_FORCE_SELL) {"
if old_force_handler in content:
    idx = content.find(old_force_handler)
    # Find the closing brace - look for the next top-level else/closing
    end = content.find('\n    }', idx + 10)
    if end > -1:
        end2 = content.find('\n    }', end + 5)
        if end2 > -1:
            content = content[:idx] + '    // ENGINE_FORCE_SELL handler: REMOVED' + content[end2 + 6:]
            fixes.append('Removed ENGINE_FORCE_SELL handler')

# 6. Remove force_sell.json reader
old_force_file = "  if (fs.existsSync(FORCE_SELL_FILE)) {"
if old_force_file in content:
    idx = content.find("const FORCE_SELL_FILE")
    if idx > -1:
        # Find end of the force_sell block
        end = content.find("} catch (e: any) { console.error('[SNIPER] force_sell.json parse error:", idx)
        if end > -1:
            end2 = content.find('\n', end) + 1
            content = content[:idx] + '  // force_sell.json: REMOVED — was causing unexpected sells\n' + content[end2:]
            fixes.append('Removed force_sell.json reader')

# 7. Remove engineForceEvict from position check
old_evict = "let forceExit = !!pos.engineForceEvict; // Only external force (Redis command)"
new_evict = "let forceExit = false; // All external force mechanisms DISABLED"
if old_evict in content:
    content = content.replace(old_evict, new_evict)
    fixes.append('Disabled forceExit — only TP/SL/time exits now')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
