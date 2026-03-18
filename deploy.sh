#!/bin/bash

# =========================================================================
# PocketChange ($PCP) Production Deployment Script
# Target: AWS EC2 / DigitalOcean Droplets (Debian/Ubuntu)
# =========================================================================

set -e

echo "🚀 Starting PocketChange ArbitraSaaS Engine Deployment..."

# 1. Ensure Docker is installed
if ! command -v docker &> /dev/null
then
    echo "⚠️ Docker is not installed on this VPS. Please install Docker Engine and docker-compose first."
    exit 1
fi

# 2. Pull the latest code (Assuming this is inside the EC2 instance already cloned)
echo "📥 Pulling latest codebase from origin main..."
git pull origin main

# 3. Securely check for Production ENV 
if [ ! -f .env ]; then
    echo "❌ ERROR: No .env attached! You must provide SOLANA_RPC, JITO credentials, and DB strings."
    exit 1
fi

# 4. Build the Rust Engine via Multi-Stage Dockerfile
echo "🏗️ Compiling Rust Engine... (This may take several minutes depending on CPU...)"
docker-compose -f docker-compose.prod.yml build arbitrage-engine

# 5. Bring down stale containers gracefully
echo "🛑 Putting old nodes gracefully offline..."
docker-compose -f docker-compose.prod.yml down

# 6. Ignite the Fleet
echo "🔥 Starting PostgreSQL, NATS, and Arbitrage Engine in detached mode..."
docker-compose -f docker-compose.prod.yml up -d

echo "✅ PocketChange Infrastructure successfully deployed to Production."
echo "📊 Run 'docker-compose -f docker-compose.prod.yml logs -f arbitrage-engine' to monitor Jito Bundling."
