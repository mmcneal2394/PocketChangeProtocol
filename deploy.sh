#!/bin/bash
# -----------------------------------------------------------------------------
# ArbitraSaaS Stack - Multi-container Deployment Pipeline
# -----------------------------------------------------------------------------
set -e

# Default environment check
if [ ! -f .env ]; then
  echo "[WARNING] No .env file found. Copying .env.example..."
  cp .env.example .env
fi

export $(grep -v '^#' .env | xargs)

echo "Starting ArbitraSaaS Deployment Process..."

# 1. Start Background Services (Postgres)
echo "> Booting PostgreSQL Database & Restoring State..."
docker-compose up -d db
sleep 5 # Await DB initialization

# 2. Build and trigger Rust Execution worker
echo "> Compiling Rust Engine Worker (Cargo Build SBF + Native)..."
docker-compose build engine-worker
docker-compose up -d engine-worker

# 3. Trigger Next.js Production Build
echo "> Compiling Next.js Dashboard Frontend..."
docker-compose build web
docker-compose up -d web

echo "--------------------------------------------------------"
echo "✅ ArbitraSaaS Deployed Successfully."
echo "Dashboard Online at: http://localhost:3000"
echo "To view engine logs: docker-compose logs -f engine-worker"
echo "--------------------------------------------------------"
