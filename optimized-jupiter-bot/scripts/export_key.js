const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('./real_wallet.json'));
const kp = Keypair.fromSecretKey(new Uint8Array(raw));

// Full 64-byte keypair as base58 (what Phantom/Backpack want)
const full58 = bs58.encode(Buffer.from(raw));
// First 32 bytes only (some wallets want just the secret scalar)
const priv58 = bs58.encode(Buffer.from(raw.slice(0, 32)));
// Hex
const hexFull = Buffer.from(raw).toString('hex');

console.log('Public key:  ', kp.publicKey.toBase58());
console.log('Key length:  ', raw.length, 'bytes');
console.log('\n-- PHANTOM / BACKPACK (64-byte base58) --');
console.log(full58);
console.log('\n-- 32-byte private scalar (base58) --');
console.log(priv58);
console.log('\n-- Full keypair hex (some importers) --');
console.log(hexFull);
