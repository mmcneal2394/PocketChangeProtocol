import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

async function check() {
  console.log('--- COMPREHENSIVE SWARM AUDIT ---');
  
  const wsolPrice = await redis.hgetall('price:So11111111111111111111111111111111111111112');
  console.log('✅ wSOL price sync alive:', Object.keys(wsolPrice).length > 0 ? 'YES' : 'NO');

  const keys = await redis.keys('*');
  console.log('✅ Total Redis Keys tracked:', keys.length);

  const wallet = await redis.get('wallet:totalValueUSD');
  console.log('✅ Wallet total USD tracked (pcp-wallet-monitor):', wallet ? `$${parseFloat(wallet).toFixed(2)}` : 'MISSING');

  const positions = await redis.keys('position:*');
  console.log(`✅ Open execution positions: ${positions.length}`);

  const performance = await redis.hgetall('config:performance');
  console.log('✅ Performance AI Config (pcp-performance):', Object.keys(performance).length > 0 ? 'ACTIVE' : 'INACTIVE', performance.winRate ? `| WinRate: ${(parseFloat(performance.winRate)*100).toFixed(1)}%` : '');

  const regime = await redis.hgetall('config:regime');
  console.log('✅ Market Regime logic:', Object.keys(regime).length > 0 ? 'ACTIVE' : 'INACTIVE');
  
  process.exit(0);
}

check().catch(e => {
    console.error("Diagnostic failure:", e);
    process.exit(1);
});
