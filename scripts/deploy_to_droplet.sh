#!/bin/bash

# =========================================================================
# PocketChange ($PCP) - Droplet Production Deployment & Doppler Setup
# =========================================================================
# This script is designed to be run on your DigitalOcean Ubuntu Droplet.
# It installs Node.js, PM2 (for persistent running), and Doppler (for Secret Injection).

set -e # Exit immediately if a command exits with a non-zero status.

echo "🚀 PocketChange Production VPS Bootstrapper"
echo "================================================="

# 1. System Updates & Node.js
echo "📦 Installing Node.js & NPM..."
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# 2. Install Doppler CLI (Industry Standard Secrets Injector)
echo "🔒 Installing Doppler CLI for Secure Secret Management..."
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' | sudo gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | sudo tee /etc/apt/sources.list.d/doppler-cli.list
sudo apt-get update && sudo apt-get install doppler

# 3. Install PM2 for Process Management
echo "⚙️ Installing PM2 globally..."
sudo npm install -g pm2

# 4. Deployment Instructions
echo " "
echo "✅ Environment Provisioned Successfully!"
echo " "
echo "Next Steps to deploy the Arbitrage Engine:"
echo "------------------------------------------"
echo "1. Clone your GitHub Repository into the Droplet:"
echo "   git clone https://github.com/YourUsername/PocketChange-Protocol.git"
echo "   cd PocketChange-Protocol"
echo " "
echo "2. Install Dependencies:"
echo "   npm install"
echo " "
echo "3. Authenticate Doppler (Links your project's secure keys):"
echo "   doppler login"
echo "   doppler setup"
echo " "
echo "4. Boot the Arbitrage Engine SECURELY injected with Doppler keys:"
echo "   pm2 start 'doppler run -- node scripts/live_arbitrage_engine.mjs' --name pc-engine"
echo " "
echo "5. Ensure the engine reboots on server crash:"
echo "   pm2 startup && pm2 save"
echo "================================================="
