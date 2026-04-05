const Redis = require('ioredis');
const r = new Redis();
r.publish('config:update', JSON.stringify({ MIN_SPREAD_PCT: 0.3 }))
  .then(n => { console.log('Delivered to', n, 'subscribers'); process.exit(0); });
