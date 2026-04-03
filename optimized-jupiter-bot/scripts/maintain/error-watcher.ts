import Redis from 'ioredis';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

console.log("[ERROR WATCHER] 👁️  Daemon online. Monitoring PM2 for 429 errors...");

setInterval(() => {
  exec('pm2 logs pcp-rpc-gateway --err --lines 50 --nostream', (err, stdout, stderr) => {
    const logs = stdout + stderr;
    if (logs.includes('429') || logs.includes('Too Many Requests')) {
      console.log("[ERROR WATCHER] 🚨 Detected 429 Rate Limit error in the last 50 logs!");
      redis.publish('system:alert', JSON.stringify({ event: 'RATE_LIMIT_EXCEEDED', module: 'pcp-rpc-gateway' }));
      // Optionally throttle explicitly or restart
    }
  });
}, 10_000); // Check every 10 seconds
