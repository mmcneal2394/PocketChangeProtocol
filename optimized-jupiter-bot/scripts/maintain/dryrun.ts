import Redis from 'ioredis';

const redis = new Redis();

async function dryrun() {
  console.log('=== Redis Architecture Dryrun ===');

  // 1. Check that market data keys exist
  const wsolMint = 'So11111111111111111111111111111111111111112';
  const price = await redis.hget(`price:${wsolMint}`, 'usd');
  console.log(`[DATA] Price for wSOL: ${price ? '✓ $' + parseFloat(price).toFixed(2) : '✗ not found'}`);

  const params = await redis.hgetall(`trade:params:${wsolMint}`);
  console.log(`[DATA] Precomputed params for wSOL: ${Object.keys(params).length > 0 ? '✓' : '✗'}`);

  // 2. Check wallet state
  const wallet = await redis.get('wallet:latest');
  let walletUsd = 'N/A';
  if (wallet) {
      try { walletUsd = JSON.parse(wallet).totalValueUSD.toFixed(2); } catch(e){}
  }
  console.log(`[STATE] Wallet total parsed: ${wallet ? '✓ $' + walletUsd : '✗'}`);

  // 3. active:mints array seeding
  const activeMints = await redis.smembers('active:mints');
  console.log(`[STATE] Active tracking mint array: ${activeMints.length > 0 ? '✓ (' + activeMints.length + ' mints)' : '⚠ empty'}`);

  // 4. Check trade stream
  const trades = await redis.xrange('stream:trades', '-', '+', 'COUNT', 1);
  console.log(`[STREAM] Trade stream 'stream:trades': ${trades.length > 0 ? '✓ has entries' : '⚠ empty - waiting for first execution'}`);

  console.log('=== Dryrun complete ===');
}

dryrun().catch(console.error).finally(() => redis.disconnect());
