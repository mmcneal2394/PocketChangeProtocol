const express = require('express');
const { createServer } = require('http');
const Redis = require('ioredis');

const app = express();
const server = createServer(app);
const redis = new Redis(); // Connects to local Redis 127.0.0.1:6379 natively

// Enable CORS cleanly for the Vercel Edge functions (if polled directly) or browser access
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// REST endpoint for aggregated Vercel data hydration
app.get('/api/initial', async (req, res) => {
    try {
        const wallet = await redis.get('wallet:latest');
        const activeMintsRaw = await redis.smembers('active:mints') || [];
        
        let walletObj = null;
        if (wallet) {
            try { walletObj = JSON.parse(wallet); } catch(e){}
        }

        // Fetch dynamic pricing/params for all actively tracked mints
        const parameters = {};
        for(const mint of activeMintsRaw) {
            const params = await redis.hgetall(`trade:params:${mint}`);
            const price = await redis.hget(`price:${mint}`, 'usd');
            if(Object.keys(params).length > 0) {
                parameters[mint] = { params, price: parseFloat(price||'0') };
            }
        }

        // Get last 20 trades from native memory stream
        let formattedTrades = [];
        try {
            const trades = await redis.xrevrange('stream:trades', '+', '-', 'COUNT', 20);
            formattedTrades = trades.map(([id, fields]) => {
                const obj = { streamId: id };
                for (let i = 0; i < fields.length; i += 2) {
                    obj[fields[i]] = fields[i+1];
                }
                return obj;
            });
        } catch(e) {} // If stream not initialized yet

        res.json({ 
            wallet: walletObj, 
            trackedAssets: activeMintsRaw, 
            parameters, 
            trades: formattedTrades 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.listen(3002, () => {
  console.log('[DASHBOARD] REST API running securely on port 3002');
});
