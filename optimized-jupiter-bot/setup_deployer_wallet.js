const fs = require('fs');
const web3 = require('@solana/web3.js');
const bs58 = require('bs58');

try {
  const pkBase58 = process.env.DEPLOYER_PRIVATE_KEY_B58;
  if (!pkBase58) {
    throw new Error('DEPLOYER_PRIVATE_KEY_B58 is required');
  }

  const decoded = bs58.decode ? bs58.decode(pkBase58) : bs58.default.decode(pkBase58);
  const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decoded));
  const walletJson = Array.from(keypair.secretKey);

  fs.writeFileSync('./wallet.json', JSON.stringify(walletJson));
  console.log('Safe deployer wallet saved to wallet.json');
  console.log('Public Key: ' + keypair.publicKey.toBase58());

  let envExample = fs.readFileSync('./.env', 'utf-8');
  envExample = envExample.replace(/WALLET_PUBLIC_KEY=.*/, 'WALLET_PUBLIC_KEY=' + keypair.publicKey.toBase58());
  fs.writeFileSync('./.env', envExample);
  console.log('.env updated to match the deployer key.');
} catch (err) {
  console.error('Error: ', err);
}
