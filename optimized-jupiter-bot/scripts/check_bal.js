const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
    const secretKey = new Uint8Array(JSON.parse(fs.readFileSync('./wallet.json', 'utf8')));
    const wallet = Keypair.fromSecretKey(secretKey);
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // get USDC balance
    const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') });
    let amount = 0;
    if (accounts.value.length > 0) amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
    
    console.log('USDC BALANCE ON DROPLET: ' + amount);
    process.exit(0);
}
main();
