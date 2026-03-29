const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: __dirname + '/.env' });

async function check() {
    const connection = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
    const secret = new Uint8Array(JSON.parse(fs.readFileSync(__dirname + '/wallet.json', 'utf8')));
    const owner = require('@solana/web3.js').Keypair.fromSecretKey(secret).publicKey;
    const TOKENS = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    
    console.log(`Checking wrapper balances for ${owner.toBase58()}`);
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKENS });
    let found = 0;
    accounts.value.forEach(a => {
        const d = a.account.data.parsed.info;
        if (d.tokenAmount.uiAmount > 0) {
            console.log(`MINT: ${d.mint} | QTY: ${d.tokenAmount.uiAmount}`);
            found++;
        }
    });

    if (found === 0) {
        console.log("No non-empty token accounts found. Wallet is clean.");
    }
}

check().catch(console.error);
