// scripts/maintain/ingestion_api.ts

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
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

    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
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
                console.error('[INGESTION] RAW BAD BODY DUMP:', body);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
    } else if (req.method === 'POST' && req.url === '/config-update') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
             try {
                 const payload = JSON.parse(body);
                 RedisBus.publish(CHANNELS.CONFIG_UPDATE, JSON.stringify(payload))
                     .then(() => console.log(`[INGESTION] Received Tuned Parameters from Remote HiveMind:`, payload))
                     .catch((e: any) => console.error('[INGESTION] Config Update Publish Failed:', e.message));
                 
                 res.writeHead(200, { 'Content-Type': 'text/plain' });
                 res.end('OK');
             } catch (err) {
                 res.writeHead(400, { 'Content-Type': 'text/plain' });
                 res.end('Invalid JSON');
             }
        });
    } else if (req.method === 'GET' && (req.url || '').startsWith('/trades')) {
        // Parse query params
        const urlObj = new URL(req.url || '/trades', `http://localhost:${PORT}`);
        const filter = urlObj.searchParams.get('filter') || '';
        const limit = parseInt(urlObj.searchParams.get('limit') || '20', 10);

        const journalPath = path.join(process.cwd(), 'signals', 'trade_journal.jsonl');
        if (!fs.existsSync(journalPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
        let trades: any[] = [];
        for (const line of lines) {
            if (!line) continue;
            try { trades.push(JSON.parse(line)); } catch {}
        }

        if (filter === 'loss') {
            trades = trades.filter((t: any) => t.action === 'SELL' && t.pnlSol !== undefined && t.pnlSol < 0);
        } else if (filter === 'win') {
            trades = trades.filter((t: any) => t.action === 'SELL' && t.pnlSol !== undefined && t.pnlSol > 0);
        }

        trades = trades.slice(-limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(trades));
    } else if (req.method === 'DELETE' && req.url === '/trades') {
        const journalPath = path.join(process.cwd(), 'signals', 'trade_journal.jsonl');
        const missedTargetsPath = path.join(process.cwd(), 'signals', 'missed_targets.jsonl');
        
        if (fs.existsSync(journalPath)) fs.writeFileSync(journalPath, '', 'utf-8');
        if (fs.existsSync(missedTargetsPath)) fs.writeFileSync(missedTargetsPath, '', 'utf-8');
        
        console.log('[INGESTION] Trade journal and missed targets wiped from disk via local machine refinement sweep');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
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
