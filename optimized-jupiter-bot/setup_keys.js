const fs = require('fs');

try {
  const pkBase58 = process.env.WALLET_PRIVATE_KEY_B58;
  if (!pkBase58) {
    throw new Error('WALLET_PRIVATE_KEY_B58 is required');
  }

  const web3 = require('@solana/web3.js');
  const bs58Lib = require('bs58');
  const decoded = bs58Lib.decode(pkBase58);
  const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decoded));
  const walletJson = Array.from(keypair.secretKey);

  fs.writeFileSync('./wallet.json', JSON.stringify(walletJson));
  console.log('Wallet saved to wallet.json');
  console.log('Public Key: ' + keypair.publicKey.toBase58());

  let envExample = fs.readFileSync('./.env.example', 'utf-8');
  envExample = envExample.replace('WALLET_KEYPAIR_PATH=./wallet.json', 'WALLET_KEYPAIR_PATH=./wallet.json');
  envExample = envExample.replace('WALLET_PUBLIC_KEY=your-public-key', 'WALLET_PUBLIC_KEY=' + keypair.publicKey.toBase58());
  fs.writeFileSync('./.env', envExample);
  console.log('.env generated from .env.example with the provided key.');
} catch (err) {
  console.error('Error: ', err);
}
