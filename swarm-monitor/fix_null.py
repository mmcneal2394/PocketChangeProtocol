path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# The "LIVE DEX DATA" log and assignments need to be inside an if(livePair) block
# Find the exact block
old_block = """          console.log(`[SNIPER] ✅ LIVE DEX DATA: ${symbol} — liq $${livePair.liquidity.toFixed(0)} | 5m: ${livePair.priceChange5m > 0 ? '+' : ''}${livePair.priceChange5m.toFixed(1)}%${livePair.boosted ? ' 🚀 BOOSTED' : ''}`);
          // Override variables with live data
          mom5m = livePair.priceChange5m;
          pc1h = livePair.priceChange1h;"""

new_block = """          if (livePair) {
            console.log(`[SNIPER] ✅ LIVE DEX DATA: ${symbol} — liq $${livePair.liquidity.toFixed(0)} | 5m: ${livePair.priceChange5m > 0 ? '+' : ''}${livePair.priceChange5m.toFixed(1)}%${livePair.boosted ? ' 🚀 BOOSTED' : ''}`);
            mom5m = livePair.priceChange5m;
            pc1h = livePair.priceChange1h;
          } else {
            console.log(`[SNIPER] ⚡ NO DEX DATA, proceeding with velocity signal only: ${symbol}`);
          }"""

if old_block in content:
    content = content.replace(old_block, new_block)
    print('OK Fixed null access on livePair in LIVE DEX DATA block')
else:
    print('SKIP: exact block not found, trying partial match')
    # Try simpler approach
    old2 = "console.log(`[SNIPER] ✅ LIVE DEX DATA: ${symbol} — liq $${livePair.liquidity.toFixed(0)}"
    if old2 in content:
        # Wrap just the log + assignments in if(livePair)
        idx = content.index(old2)
        # Find start of line
        line_start = content.rfind('\n', 0, idx)
        # Find end of the block (pc1h assignment)
        end_marker = "pc1h = livePair.priceChange1h;"
        end_idx = content.index(end_marker, idx) + len(end_marker)
        
        old_section = content[line_start+1:end_idx]
        indent = '          '
        new_section = f"""{indent}if (livePair) {{
{indent}  console.log(`[SNIPER] ✅ LIVE DEX DATA: ${{symbol}} — liq $${{livePair.liquidity.toFixed(0)}} | 5m: ${{livePair.priceChange5m > 0 ? '+' : ''}}${{livePair.priceChange5m.toFixed(1)}}%${{livePair.boosted ? ' 🚀 BOOSTED' : ''}}`);
{indent}  mom5m = livePair.priceChange5m;
{indent}  pc1h = livePair.priceChange1h;
{indent}}} else {{
{indent}  console.log(`[SNIPER] ⚡ NO DEX DATA, velocity-only: ${{symbol}}`);
{indent}}}"""
        content = content[:line_start+1] + new_section + content[end_idx:]
        print('OK Fixed via partial match')

with open(path, 'w') as f:
    f.write(content)
