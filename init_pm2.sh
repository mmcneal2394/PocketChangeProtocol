#!/bin/bash
pkill -f live_arbitrage_engine || true
cd /opt/pcprotocol
npm install -g pm2
pm2 stop all || true
pm2 start ecosystem.config.js --only live-arbitrage-engine
pm2 save
