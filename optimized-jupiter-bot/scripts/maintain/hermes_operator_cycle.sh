#!/bin/bash
set -e
export HERMES_HOME="/var/www/pcprotocol/.hermes"
cd /var/www/pcprotocol
pcprotocol profile use pcprotocol >/dev/null 2>&1 || true
node scripts/maintain/hermes_orchestrator.js
node scripts/maintain/validate_orchestrator_output.js
node scripts/maintain/compact_swarm_memory.js
