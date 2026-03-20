const fs = require('fs');
const bs58 = require('bs58'); // bs58 is usually available with solana/web3.js or we can require solana/web3.js directly if bs58 is not installed.
// Wait, @solana/web3.js has require('@solana/web3.js').Keypair.fromSecretKey... wait, the fromSecretKey takes Uint8Array. 
// bs58 is an external dependency, actually we can just use bs58 directly if it's in node_modules

try {
  const pkBase58 = "2Z1gEB9B4vAoxhTZt1DzrmVGjJxkN54MwoAarmNp8h69KDKY6ECFmPGxcwNUa9Pj8gctt7wvMeRYUaqo74fJYNAt";
  
  // Decoding using a custom base58 because we don't know if bs58 is directly available
  const web3 = require('@solana/web3.js');
  // Usually web3.js doesn't expose bs58 directly in the top level. We can use the npm package bs58 which is often a dependency.
  // Actually, web3.js might not install bs58 at the top level in npm v9+. Let's just create a raw keypair if possible, or try to load bs58.
  
  let decoded;
  try {
    const bs58Lib = require('bs58');
    decoded = bs58Lib.decode(pkBase58);
  } catch(e) {
    // Write a quick base58 decoder
    var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var ALPHABET_MAP = {};
    for(var i = 0; i < ALPHABET.length; i++) {
        ALPHABET_MAP[ALPHABET.charAt(i)] = i;
    }
    var BASE = 58;
    function decode(string) {
        if (string.length === 0) return new Uint8Array(0);
        var bytes = [0];
        for (var i = 0; i < string.length; i++) {
            var c = string[i];
            if (!(c in ALPHABET_MAP)) throw new Error('Non-base58 character');
            for (var j = 0; j < bytes.length; j++) bytes[j] *= BASE;
            bytes[0] += ALPHABET_MAP[c];
            var carry = 0;
            for (var j = 0; j < bytes.length; j++) {
                bytes[j] += carry;
                carry = bytes[j] >> 8;
                bytes[j] &= 0xff;
            }
            while (carry) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }
        for (var i = 0; string[i] === '1' && i < string.length - 1; i++) bytes.push(0);
        return new Uint8Array(bytes.reverse());
    }
    decoded = decode(pkBase58);
  }

  const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decoded));
  const walletJson = Array.from(keypair.secretKey);
  
  fs.writeFileSync('./wallet.json', JSON.stringify(walletJson));
  console.log("Wallet saved to wallet.json");
  console.log("Public Key: " + keypair.publicKey.toBase58());

  let envExample = fs.readFileSync('./.env.example', 'utf-8');
  envExample = envExample.replace('WALLET_KEYPAIR_PATH=./wallet.json', 'WALLET_KEYPAIR_PATH=./wallet.json');
  envExample = envExample.replace('WALLET_PUBLIC_KEY=your-public-key', 'WALLET_PUBLIC_KEY=' + keypair.publicKey.toBase58());
  fs.writeFileSync('./.env', envExample);
  console.log(".env generated from .env.example with the user's key.");
} catch(err) {
  console.error("Error: ", err);
}
