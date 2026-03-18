import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const key = process.env.SOLANA_PRIVATE_KEY;
if (key) {
    const keypair = web3.Keypair.fromSecretKey(bs58.decode(key));
    console.log("The .env key public address is:", keypair.publicKey.toBase58());
} else {
    console.log("No key found");
}
