import os, subprocess

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain'
services = ['momentum_sniper', 'velocity_stream', 'ingestion', 'wallet_monitor', 'stale_sweeper', 'gas_monitor', 'rpc_gateway']

rpc_patterns = ['callRpcGateway', 'getBalance', 'getTokenAccountsByOwner', 'getAccountInfo', 
                'getTokenLargest', 'getSignatures', 'getTransaction', 'sendTransaction', 
                'connection.', 'RPC_ENDPOINT']

print('=== RPC CALL SITES BY SERVICE ===')
for svc in services:
    fpath = os.path.join(BASE, svc + '.ts')
    if not os.path.exists(fpath):
        print(f'  {svc}: FILE NOT FOUND')
        continue
    with open(fpath) as f:
        code = f.read()
    total = 0
    details = []
    for pat in rpc_patterns:
        count = code.count(pat)
        if count > 0:
            total += count
            details.append(f'{pat}={count}')
    print(f'  {svc}: {total} calls  [{", ".join(details)}]')

# Check intervals
print('\n=== POLLING INTERVALS ===')
for svc in services:
    fpath = os.path.join(BASE, svc + '.ts')
    if not os.path.exists(fpath):
        continue
    with open(fpath) as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        if 'setInterval' in line or 'POLL' in line.upper():
            print(f'  {svc}:{i+1}: {line.strip()[:100]}')

# Check which services use Chainstack directly
print('\n=== CHAINSTACK DIRECT USAGE ===')
for svc in services:
    fpath = os.path.join(BASE, svc + '.ts')
    if not os.path.exists(fpath):
        continue
    with open(fpath) as f:
        code = f.read()
    if 'chainstack' in code.lower() or 'RPC_ENDPOINT' in code:
        print(f'  {svc}: USES CHAINSTACK')

print('\n=== STOPPABLE SERVICES ===')
print('  Services that could be stopped to save RPC:')
# Check what pcp-wallet-monitor, pcp-stale-sweeper, pcp-gas-monitor actually do
for svc in ['wallet_monitor', 'stale_sweeper', 'gas_monitor']:
    fpath = os.path.join(BASE, svc + '.ts')
    if os.path.exists(fpath):
        with open(fpath) as f:
            code = f.read()
        lines = len(code.split('\n'))
        intervals = code.count('setInterval')
        rpc = sum(code.count(p) for p in rpc_patterns)
        print(f'  {svc}: {lines} lines, {intervals} intervals, {rpc} RPC calls')
