const fs = require('fs');
const web3 = require('@solana/web3.js');
const bs58 = require('bs58'); // Assuming it's installed now 

try {
  const pkBase58 = "2CMDiegi94bhpvdy14w1KzTtuKbc59vfaT6FS4XK3DacNXG7pHaBxAVHQeKzRUTkGMVuvSdaso8ARhyq5GfghErW";
  let decoded;
  if(bs58.decode) {
    decoded = bs58.decode(pkBase58);
  } else if (bs58.default && bs58.default.decode) {
    decoded = bs58.default.decode(pkBase58);
  } else {
     throw new Error("Cannot evaluate bs58 library");
  }

  const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decoded));
  const walletJson = Array.from(keypair.secretKey);
  
  fs.writeFileSync('./wallet.json', JSON.stringify(walletJson));
  console.log("Safe deployer wallet saved to wallet.json");
  console.log("Public Key: " + keypair.publicKey.toBase58());

  let envExample = fs.readFileSync('./.env', 'utf-8');
  // Just update the public key entry
  envExample = envExample.replace(/WALLET_PUBLIC_KEY=.*/, 'WALLET_PUBLIC_KEY=' + keypair.publicKey.toBase58());
  fs.writeFileSync('./.env', envExample);
  console.log(".env generated mapped to Deployer Key.");
} catch(err) {
  console.error("Error: ", err);
}
