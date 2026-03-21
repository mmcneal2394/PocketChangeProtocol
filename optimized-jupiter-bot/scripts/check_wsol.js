require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const fs = require('fs');
const conn = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const wSOL = new PublicKey('So11111111111111111111111111111111111111112');
(async()=>{
  const ata = await getAssociatedTokenAddress(wSOL, wallet.publicKey);
  console.log('wSOL ATA:', ata.toBase58());
  const solBal = await conn.getBalance(wallet.publicKey);
  console.log('Native SOL:', (solBal/1e9).toFixed(6));
  try {
    const tok = await conn.getTokenAccountBalance(ata);
    console.log('wSOL balance:', tok.value.uiAmount);
  } catch(e) { console.log('wSOL ATA: not found / empty'); }
})();
