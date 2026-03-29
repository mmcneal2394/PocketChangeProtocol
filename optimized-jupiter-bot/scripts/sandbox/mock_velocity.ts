import RedisBus from '../../src/utils/redis_bus';

// A mock payload representative of the real velocity output
interface VelocitySignal {
    mint: string;
    symbol: string;
    velocityScore: number;
    volume5m: number;
    priceChange5m: number;
    timestamp: number;
}

// Emits fake signals on an interval
async function startSyntheticStream() {
    console.log(`[VELOCITY-MOCK] 🏎️ Starting synthetic stream. Publishing to Redis...`);
    
    setInterval(async () => {
        // Generate a randomized high momentum coin
        const randomMint = `MOCK${Math.floor(Math.random() * 9000) + 1000}MintAddress`;
        
        const payload: VelocitySignal = {
            mint: randomMint,
            symbol: `MOCK${Math.floor(Math.random() * 100)}`,
            velocityScore: (Math.random() * 10).toFixed(2) as any as number,
            volume5m: Math.floor(Math.random() * 80000) + 5000,
            priceChange5m: parseFloat((Math.random() * 20).toFixed(2)),
            timestamp: Date.now()
        };

        console.log(`[VELOCITY-MOCK] 📤 Emitting -> ${payload.symbol} | Chg: +${payload.priceChange5m}% | Vol: $${payload.volume5m}`);
        
        // PUBLISH entirely in-memory! No fs.writeFileSync lag
        await RedisBus.publish('signal:velocity', payload);
        
    }, 2500); // Posts every 2.5 seconds
}

if (require.main === module) {
    startSyntheticStream();
}
