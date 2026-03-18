import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
dotenv.config();

const keys = process.env.TEST_KEYS_JSON ? JSON.parse(process.env.TEST_KEYS_JSON) : [];
keys.forEach(k => {
  try {
    const pub = Keypair.fromSecretKey(bs58.decode(k)).publicKey.toBase58();
    console.log(pub, "=>", k);
  } catch(e) {
    console.error("Error with key:", k, e.message);
  }
});
