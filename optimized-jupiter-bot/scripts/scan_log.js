const path = require('path');
const os   = require('os');
const fs   = require('fs');
const LOG  = path.join(os.homedir(), '.pm2', 'logs', 'pipeline-test-out.log');
const lines = fs.readFileSync(LOG, 'utf8').split('\n');
lines.slice(-60).forEach(l => console.log(l));
