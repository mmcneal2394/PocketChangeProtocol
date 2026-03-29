const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const JTR = require('node-fetch').default || require('node-fetch');

async function main() {
    console.log('--- FINAL USDC SWEEP (LOW GAS) ---');
    const secretKey = new Uint8Array(JSON.parse(fs.readFileSync('./wallet.json', 'utf8')));
    const wallet = Keypair.fromSecretKey(secretKey);
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // get USDC balance
    const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') });
    let amount = 0;
    if (accounts.value.length > 0) amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (amount === '0' || amount === 0) { console.log('✅ USDC balance is already 0! Sweep successful.'); return; }
    
    console.log('USDC Balance found: ' + amount);
    
    // We must restrict priority fees to 0.0001 SOL (100k lamports) because wallet only has 0.0009 native SOL left!
    // Exceeding 900k lamports throws silent InsufficientFunds on SendTransaction.
    
    const JUP_KEY = 'HIDDEN_KEY';
    const headers = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
    
    // outputMint is natively SOL (not WSOL) so we unwrap automatically!
    const qUrl = 'https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=' + amount + '&slippageBps=2000';
    let res = await JTR(qUrl, { headers });
    const quote = await res.json();
    if (!quote.outAmount) { console.log('Quote JSON failed:', quote); return; }
    
    console.log('Quote outAmount: ' + quote.outAmount);
    
    const sUrl = 'https://api.jup.ag/swap/v1/swap';
    let sRes = await JTR(sUrl, { method: 'POST', headers, body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true, // We want Native SOL back!
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000 // Very low priority fee to ensure it fits the 0.0009 SOL budget
    })});
    
    const swapData = await sRes.json();
    if (!swapData.swapTransaction) { console.log('Swap Failed JSON:', swapData); return; }
    
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([wallet]);
    
    try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        console.log('TX Sent: https://solscan.io/tx/' + sig);
        const blockhash = await conn.getLatestBlockhash('confirmed');
        const conf = await conn.confirmTransaction({ signature: sig, ...blockhash }, 'confirmed');
        if (conf.value.err) {
            console.log('Error Conf:', conf.value.err);
        } else {
            console.log('✅ SWAP CONFIRMED NATIVELY!!!!!');
        }
    } catch(e) {
        console.dir(e, { depth: null });
        console.log('TX Submit failed:', e.message);
    }
}
main();
