import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const keys = (process.env.WALLET_SECRET_KEYS_B58 || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);

if (keys.length === 0) {
  console.log('No WALLET_SECRET_KEYS_B58 values provided.');
  process.exit(0);
}

for (const k of keys) {
    try {
        const kp = Keypair.fromSecretKey(bs58.decode(k));
        console.log(`${kp.publicKey.toBase58()} = ${k}`);
        if(kp.publicKey.toBase58().startsWith("E883BM")){
            console.log("\n*** MATCH FOUND ***: ", k);
        }
    } catch (e) {
        // ignore
    }
}
