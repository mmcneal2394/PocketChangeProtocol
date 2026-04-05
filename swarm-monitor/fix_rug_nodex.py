path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Fix 1: RugCheck error handling
old_rug = "    const data = await res.json() as any;\n    const score = data.score || 0;"
new_rug = "    const data = await res.json() as any;\n    if (data.error) return { safe: true, riskLevel: 'NO_REPORT', score: 0 };\n    const score = data.score || 0;"
if old_rug in content:
    content = content.replace(old_rug, new_rug)
    fixes.append('Fixed RugCheck error handling')

# Fix 2: ensure risks is always an array  
old_risks = "    const risks = data.risks || [];"
new_risks = "    const risks = Array.isArray(data.risks) ? data.risks : [];"
if old_risks in content:
    content = content.replace(old_risks, new_risks)
    fixes.append('Fixed risks array check')

# Fix 3: replace NO DEX DATA velocity-only with a reject
# The line is inside an else block in the if(!trending) section
old_txt = 'NO DEX DATA, proceeding with velocity signal only'
if old_txt in content:
    # Replace the log message
    content = content.replace(old_txt, 'NO DEX DATA — skipping (need price confirmation)')
    # Now find this new line and add continue after it
    new_txt = 'NO DEX DATA — skipping (need price confirmation)'
    idx = content.index(new_txt)
    # Find the `);\n` after the console.log
    end_of_log = content.index('\n', idx)
    next_content = content[end_of_log+1:end_of_log+100]
    if 'continue' not in next_content:
        content = content[:end_of_log+1] + '            continue;\n' + content[end_of_log+1:]
        fixes.append('Added continue after NO DEX DATA log to block entry')
    fixes.append('Changed NO DEX DATA message to rejection')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
