import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });
const RPC_HTTP = process.env.RPC_ENDPOINT!;
const WS_URL = RPC_HTTP.replace('https://', 'wss://').replace('http://', 'ws://');

const ws = new WebSocket(WS_URL);
ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] }, { commitment: 'processed' }]
    }));
});

let matches = 0;
ws.on('message', (data: string) => {
    const raw = data.toString();
    const msg = JSON.parse(raw);
    const logs = msg?.params?.result?.value?.logs;
    if (logs && logs.length > 0) {
        console.log("----- PUMP.FUN TX LOGS -----");
        console.log(logs.join('\n'));
        matches++;
        if (matches >= 3) {
            console.log("\nGot 3 samples. Exiting.");
            process.exit(0);
        }
    }
});
