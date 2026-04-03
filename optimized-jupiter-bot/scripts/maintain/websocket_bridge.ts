import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { config } from 'dotenv';
import http from 'http';

config();

const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const WS_PORT = parseInt(process.env.WS_PORT || '8080');

const redis = new Redis(REDIS_URL);

// Use a raw HTTP server to attach WSS (allows for health checks if needed)
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('WS Bridge Online\n');
});
const wss = new WebSocketServer({ server });

console.log(`[WS Bridge] Listening on port ${WS_PORT}`);

// Subscribe to relevant Redis channels
redis.subscribe('CONFIG_UPDATE', 'HEARTBEAT', 'TARGET_QUALIFIED');

redis.on('message', (channel, message) => {
  // Broadcast to all connected WebSocket clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ channel, data: JSON.parse(message) }));
    }
  });
});

wss.on('connection', (ws) => {
  console.log('[WS Bridge] Client connected');
  ws.on('close', () => console.log('[WS Bridge] Client disconnected'));
});

server.listen(WS_PORT);
