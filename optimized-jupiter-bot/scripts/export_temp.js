const fs = require('fs');
const bs58 = require('bs58');
const key = new Uint8Array(JSON.parse(fs.readFileSync('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/wallet.json')));
console.log('');
console.log('--- PRIVATE KEY (BASE58) ---');
console.log(bs58.encode(key));
console.log('----------------------------');
console.log('');
