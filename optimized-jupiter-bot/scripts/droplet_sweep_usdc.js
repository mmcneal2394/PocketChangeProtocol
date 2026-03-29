const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const JTR = require('node-fetch').default || require('node-fetch');

async function main() {
    console.log('--- NATIVE USDC DROPLET SWAP ---');
    const secretKey = new Uint8Array(JSON.parse(fs.readFileSync('./wallet.json', 'utf8')));
    const wallet = Keypair.fromSecretKey(secretKey);
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // get USDC balance
    const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') });
    let amount = 0;
    if (accounts.value.length > 0) amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (amount === '0' || amount === 0) { console.log('✅ USDC balance is already 0! Sweep successful.'); return; }
    
    console.log('USDC Balance found: ' + amount);
    
    const JUP_KEY = 'HIDDEN_KEY'; // Hardcoded verify from .env
    const headers = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
    
    while(true) {
        console.log('Fetching quote...');
        // Fixed URL to v1 api endpoint!
        const qUrl = 'https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=' + amount + '&slippageBps=2000';
        let res;
        try { res = await JTR(qUrl, { headers, timeout: 5000 }); } catch (e) { console.log('Quote fetch failed, retrying...', e.message); await new Promise(r=>setTimeout(r, 1000)); continue; }
        
        const quote = await res.json();
        if (!quote.outAmount) { console.log('Quote JSON failed:', quote); await new Promise(r=>setTimeout(r, 2000)); continue; }
        
        console.log('Quote outAmount: ' + quote.outAmount);
        
        const sUrl = 'https://api.jup.ag/swap/v1/swap';
        let sRes;
        try {
            sRes = await JTR(sUrl, { method: 'POST', headers, body: JSON.stringify({
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toBase58(),
                wrapAndUnwrapSol: false,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 3000000 
            })});
        } catch(e) { console.log('Swap fetch failed, retrying...', e.message); await new Promise(r=>setTimeout(r, 1000)); continue; }
        
        const swapData = await sRes.json();
        if (!swapData.swapTransaction) { console.log('Swap Failed JSON:', swapData); await new Promise(r=>setTimeout(r, 2000)); continue; }
        
        const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
        tx.sign([wallet]);
        
        console.log('Sending TX natively...');
        try {
            const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            console.log('TX Sent: https://solscan.io/tx/' + sig);
            console.log('Awaiting confirmation...');
            const blockhash = await conn.getLatestBlockhash('confirmed');
            const conf = await conn.confirmTransaction({ signature: sig, ...blockhash }, 'confirmed');
            if (conf.value.err) {
                console.log('Error Conf:', conf.value.err, 'RETRIYING BLOCK...');
                continue; // Retry loop!
            }
            console.log('✅ SWAP CONFIRMED NATIVELY!!!!!');
            break;
        } catch(e) {
            console.log('TX Submit failed, retrying...', e.message);
        }
    }
}
main();
