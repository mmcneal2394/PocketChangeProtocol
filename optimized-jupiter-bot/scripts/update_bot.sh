#!/bin/bash
# ==========================================
# PCProtocol Sub-5ms Droplet Sync Deployment
# ==========================================
set -e

echo "🚀 Initiating Sub-5ms Trading Engine Sync..."
cd /opt/pcprotocol/optimized-jupiter-bot || exit

echo "📦 Pulling latest refinement matrices from upstream..."
git pull origin master

echo "⚙️ Installing physical dependencies silently..."
npm install --silent

echo "🔄 Compiling TypeScript payload binaries natively..."
npx tsc

echo "🔥 Relaying continuous restart through PM2..."
pm2 restart all || pm2 start dist/index.js --name "arbitrage-engine"

echo "✅ Sub-5ms Live Trading Engine successfully updated!"
