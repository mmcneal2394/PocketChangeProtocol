const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const kp = Keypair.generate();
const outPath = path.join(__dirname, '..', 'test_wallet.json');
fs.writeFileSync(outPath, JSON.stringify(Array.from(kp.secretKey)));

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║         TEST WALLET GENERATED                        ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');
console.log('  Public Key  :', kp.publicKey.toBase58());
console.log('  Keypair file:', outPath);
console.log('');
console.log('  → Fund this address with SOL on mainnet-beta');
console.log('  → Then set in .env:');
console.log('    WALLET_KEYPAIR_PATH=' + outPath);
console.log('');
console.log('  ⚠️  Keep test_wallet.json secure - never commit it');
console.log('');
