import Client from '@triton-one/yellowstone-grpc';

async function run() {
    console.log("Starting Geyser Test...");
    const client = new Client("https://yellowstone-solana-mainnet.core.chainstack.com:443", "YOUR_CHAINSTACK_KEY", undefined);
    
    try {
        const stream = await client.subscribe();
        console.log("Connected synchronously...");
        
        stream.on('data', (data) => {
            console.log("Account tick fired!");
            process.exit(0);
        });
        
        stream.on('error', (err) => console.log("Stream err:", err));
        
        stream.write({
            accounts: {
                "sol_usdc": { account: ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUvbMT12EzEQBd"] }
            },
            slots: {}, transactions: {}, blocks: {}, blocksMeta: {}, entry: {}, 
            commitment: 1
        }, (err) => {
            if (err) console.error("Write error:", err);
            else console.log("Subscribed globally.");
        });
    } catch (e) {
        console.error("Crash:", e);
    }
}
run();
