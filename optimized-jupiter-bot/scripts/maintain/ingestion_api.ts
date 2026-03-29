// scripts/maintain/ingestion_api.ts

import * as http from 'http';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';

const PORT = 3001;

const server = http.createServer((req, res) => {
    // Enable CORS for flexibility
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/velocity-spike') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.mint) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Missing mint');
                    return;
                }

                const swaps = data.swaps || 10;
                
                // Remap the lightweight webhook JSON to the exact format the Sniper anticipates
                const formattedPayload = {
                    updatedAt: data.timestamp || Date.now(),
                    mints: {
                        [data.mint]: {
                            buys60s: swaps,
                            sells60s: 0,
                            buyRatio60s: 1.0,         
                            velocity: swaps,           
                            isAccelerating: true,
                            solVolume60s: 0
                        }
                    }
                };

                // Native ioredis publish (creates a temporary publisher if one doesn't exist)
                RedisBus.publish(CHANNELS.VELOCITY_SPIKE, formattedPayload)
                    .then(() => {
                        console.log(`[INGESTION] Published Webhook Spike: ${data.mint} (${swaps} swaps)`);
                    })
                    .catch((e: any) => {
                        console.error('[INGESTION] Redis publish failed:', e.message);
                    });

                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } catch (err) {
                console.error('[INGESTION] Parse error on incoming webhook:', err);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║      PCP RAILWAY INGESTION API v1.0      ║`);
    console.log(`║      Listening on 0.0.0.0:${PORT}             ║`);
    console.log(`╚══════════════════════════════════════════╝`);
});
