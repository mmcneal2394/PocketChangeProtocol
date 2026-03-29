const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: __dirname + '/.env' });

async function sellAll() {
    const connection = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
    const secret = new Uint8Array(JSON.parse(fs.readFileSync(__dirname + '/wallet.json', 'utf8')));
    const wallet = Keypair.fromSecretKey(secret);
    
    // We fetch quote from jupiter and execute
    const tokens = [
        { mint: '7hpAfzJpaYRwRDptJbxXAdbBWQ1Zvs5X7eEy8UYqt3rQ', type: 'Rise or Nova', qty: Math.floor(34101.479323 * 1e6) },
        { mint: 'FQ8T5dNMZzRLhrjih6H4SBAXrdTC6dPZzwDxJuEoqtUv', type: 'Orphan Token', qty: Math.floor(8653.97145 * 1e6) }
    ];
    
    const WSOL = 'So11111111111111111111111111111111111111112';

    for (let t of tokens) {
        console.log(`Getting quote to dump ${t.type}...`);
        try {
            const fetchQuote = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${t.mint}&outputMint=${WSOL}&amount=${t.qty}&slippageBps=1500`);
            const quote = await fetchQuote.json();
            
            if (quote.error) {
                 console.log(`Failed to quote ${t.mint}: ${quote.error}`);
                 continue;
            }

            const fetchSwap = await fetch('https://api.jup.ag/swap/v1/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: wallet.publicKey.toBase58(),
                    wrapAndUnwrapSol: false,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 50000
                })
            });
            const swapData = await fetchSwap.json();
            if (swapData.swapTransaction) {
                 const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
                 tx.sign([wallet]);
                 const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                 console.log(`✅ Dumped ${t.type}. Signature: https://solscan.io/tx/${sig}`);
            }
        } catch(e) { console.error(`Failed ${t.mint}`, e); }
    }
}
sellAll();
