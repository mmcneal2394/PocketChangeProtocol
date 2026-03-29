#!/bin/bash
source ~/.bashrc
export PATH=$PATH:/root/.bun/bin:/root/.nvm/versions/node/v20.0.0/bin
cd /mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot

# First try to resurrect state if it exists
/usr/bin/pm2 resurrect

# If that fails to load any processes, start from config
process_count=$(/usr/bin/pm2 jlist | grep -o 'pm2_env' | wc -l)
if [ "$process_count" -eq 0 ]; then
    echo "No processes found in dump. Starting fresh from ecosystem configuration..."
    /usr/bin/pm2 start ecosystem.config.js
fi

# Ensure missing critical agents are explicitly stated
/usr/bin/pm2 start scripts/launch_ai_loop.js --name pcp-critic 2>/dev/null
/usr/bin/pm2 start scripts/maintain/momentum_sniper.ts --name pcp-apex-predator --interpreter ts-node 2>/dev/null
/usr/bin/pm2 start scripts/maintain/wallet_tracker.ts --name pcp-wallet-tracker --interpreter ts-node 2>/dev/null

/usr/bin/pm2 save
/usr/bin/pm2 status
