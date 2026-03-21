import Client from '@triton-one/yellowstone-grpc';
import dotenv from 'dotenv';
dotenv.config({ path: './optimized-jupiter-bot/.env' });

async function run() {
    console.log(`Connecting to: ${process.env.GEYSER_RPC}`);
    const client = new Client(process.env.GEYSER_RPC!, process.env.GEYSER_KEY!, undefined);
    
    try {
        const stream = await client.subscribe();
        console.log("Stream acquired.");
        
        stream.on('data', (data) => {
            if (data.account) {
                console.log("Account update caught!", data.account.account.pubkey.toString('base64'));
                process.exit(0);
            }
        });
        
        stream.on('error', (err) => console.log("Stream error:", err));
        
        stream.write({
            accounts: {
                "tracker": { account: ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUvbMT12EzEQBd"] }
            },
            slots: {}, transactions: {}, blocks: {}, blocksMeta: {}, entry: {}, commitment: 1
        }, (err) => {
            if (err) console.error("Write error:", err);
            else console.log("Subscribed globally.");
        });
    } catch (e: any) {
        console.error("Geyser crash:", e.message);
    }
}
run();
