import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

async function testBuyLogic(mint: string, currentPrice: number, walletValue: number) {
  const params = await redis.hgetall(`trade:params:${mint}`);
  if (!params || Object.keys(params).length === 0) {
      console.log(`[TEST] ❌ No params found for ${mint}`);
      return false;
  }

  console.log(`\n--- Evaluating ${mint} at $${currentPrice.toFixed(4)} ---`);
  console.log(`📈 Expected Value (EV): ${params.expectedValue}`);

  if (params.isProfitable === 'false') {
      console.log(`[TEST] ⏭️ Rejected: Negative Expected Value`);
      return false;
  }

  const maxPrice = parseFloat(params.maxBuyPrice);
  if (currentPrice > maxPrice) {
    console.log(`[TEST] 🚨 Rejected: Price ($${currentPrice.toFixed(4)}) exceeds Max Slippage Threshold ($${maxPrice.toFixed(4)})`);
    return false;
  }

  const positionSize = parseFloat(params.positionSizeTokens);
  const riskAmount = positionSize * currentPrice;
  const riskPercent = riskAmount / walletValue;

  console.log(`🧠 Kelly Position Size: ${positionSize.toFixed(2)} Tokens`);
  console.log(`💰 Capital Allocation: $${riskAmount.toFixed(2)} (${(riskPercent*100).toFixed(2)}% of wallet)`);

  if (riskPercent > 0.05) { // safety cap 5%
    console.log(`[TEST] ⚠️ Rejected: Algorithm attempting to over-allocate risk (${(riskPercent*100).toFixed(1)}% > 5% max)`);
    return false;
  }

  console.log(`✅ TEST PASSED: Sniper is mathematically cleared to execute size $${riskAmount.toFixed(2)}.`);
  return true;
}

async function runTests() {
    console.log('🧪 Simulating formulas against Redis Market Data...');
    const activeMints = await redis.smembers('active:mints');
    
    // Simulate with dummy pricing inputs derived slightly below/above the bounds
    for (const mint of activeMints.slice(0, 3)) { // just test top 3
        const realPrice = parseFloat(await redis.hget(`price:${mint}`, 'usd') || '0');
        if (realPrice > 0) {
            // Test 1: Perfect Entry
            await testBuyLogic(mint, realPrice * 1.001, 15000);
            
            // Test 2: Slippage Reject
            await testBuyLogic(mint, realPrice * 1.050, 15000);
        }
    }
    
    process.exit(0);
}

runTests();
