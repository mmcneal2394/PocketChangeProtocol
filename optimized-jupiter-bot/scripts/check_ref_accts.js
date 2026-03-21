require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const c = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
const addrs = [
  '4y7GcNrSmDjM1AfF7hz32M2Pz3rHL62YdAscC3kFkmH9',
  'J3N5dAucjdUohr6QDCyRoxu7jsJMo6Zk56Xhxx17XGsk'
];
const wSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Jupiter referral token account layout (274 bytes):
// 8 discriminator | 32 project | 32 referral | 32 mint | ...
(async () => {
  for (const a of addrs) {
    const i = await c.getAccountInfo(new PublicKey(a));
    if (!i) { console.log(a, '=> NOT FOUND'); continue; }
    const data = i.data;
    // Try different offsets to find the mint pubkey
    const candidates = [8, 40, 72, 104]; // common offsets after discriminators
    for (const off of candidates) {
      if (off + 32 > data.length) continue;
      const key = new PublicKey(data.slice(off, off+32)).toBase58();
      const label = key === wSOL ? 'wSOL' : key === USDC ? 'USDC' : null;
      if (label) {
        console.log(`\n✅ ${a}`);
        console.log(`   MINT: ${label} (at offset ${off})`);
        console.log(`   Key:  ${key}`);
        break;
      }
    }
    // Also dump all 32-byte windows as pubkeys for debugging
    console.log(`   addr: ${a.slice(0,8)}...`);
    for (const off of [8,40,72]) {
      if (off+32<=data.length) {
        const k = new PublicKey(data.slice(off,off+32)).toBase58();
        console.log(`   [${off}]: ${k}`);
      }
    }
  }
})().catch(e => console.error('ERR:', e.message));
