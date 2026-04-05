path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Fix 1: Lower default buy tip from 25000 to 10000 (0.00001 SOL)
content = content.replace(
    'tipLamports = 25000',
    'tipLamports = 10000'
)

# Fix 2: Slash sell priority fees drastically  
# Normal sell: 250K -> 15K, TP sell: 150K -> 10K, Emergency: 5M -> 100K
content = content.replace(
    'const priorityFee = tpHit ? 150_000 : isEmergencyExit ? 5_000_000 : 250_000; // 0.005 SOL tip for emergency dumps!',
    'const priorityFee = tpHit ? 10_000 : isEmergencyExit ? 100_000 : 15_000; // Gas-optimized: ~0.0001 SOL max'
)

# Fix 3: Lower the PRIORITY_FEE_MICROLAMPORTS config override default
content = content.replace(
    "PRIORITY_FEE_MICROLAMPORTS: 75000",
    "PRIORITY_FEE_MICROLAMPORTS: 10000"
)

with open(path, 'w') as f:
    f.write(content)
print('GAS FIXED: buy=10K, sell=15K, TP=10K, emergency=100K lamports')
