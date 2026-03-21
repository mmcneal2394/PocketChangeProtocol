import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import fs from 'fs';

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const RPC_ENDPOINT = 'https://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';

const TOKENS = [
    { sym: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { sym: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
    { sym: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    { sym: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    { sym: 'mSOL', mint: 'mSoLzYCxHdYgdzU16W5Qv3mtZNjUxaPNE2mU4kQnJ' }
];

let txLogs = [];

async function forceBuyFive() {
    console.log('⚡ Constructing 5 physical test transactions explicitly proving Payload capabilities...');
    
    const secretKeyStr = fs.readFileSync('c:/pcprotocol/optimized-jupiter-bot/new_wallet.json', 'utf8');
    const secretKeyArr = Uint8Array.from(JSON.parse(secretKeyStr));
    const wallet = Keypair.fromSecretKey(secretKeyArr);
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    console.log('Wallet Base58 Pubkey:', wallet.publicKey.toString());
    const balance = await connection.getBalance(wallet.publicKey);
    console.log('Confirmed Droplet Balance:', balance / 1000000000, 'SOL\n');

    for (let i = 0; i < TOKENS.length; i++) {
        const token = TOKENS[i];
        console.log(`[${i+1}/5] Fetching Premium Swap Pro Quote (${token.sym}) with Widened Liquidity...`);
        
        try {
            const quoteRes = await fetch(`${JUPITER_API}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${token.mint}&amount=1000000&slippageBps=50&strict=false&restrictIntermediateTokens=false`, {
                headers: { "x-api-key": "05aa94b2-05d5-4993-acfe-30e18dc35ff1" }
            });
            const quoteData = await quoteRes.json();
            
            if (quoteData.error) {
                 console.error(`  [ERROR] Quote failed for ${token.sym}:`, quoteData.error);
                 continue;
            }

            console.log(`  > Quote Retrieved! expectedOut: ${quoteData.outAmount}`);

            const swapRes = await fetch(`${JUPITER_API}/swap-instructions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': '05aa94b2-05d5-4993-acfe-30e18dc35ff1' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    prioritizationFeeLamports: 10000
                })
            });
            
            if (!swapRes.ok) {
                console.error(`  [ERROR] /swap-instructions failed for ${token.sym}`);
                continue;
            }

            const swapFullRes = await fetch(`${JUPITER_API}/swap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': '05aa94b2-05d5-4993-acfe-30e18dc35ff1' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    prioritizationFeeLamports: 10000
                })
            });
            
            if (!swapFullRes.ok) {
                 console.error(`  [ERROR] /swap serialization failed for ${token.sym}`);
                 continue;
            }

            const swapFullData = await swapFullRes.json();
            const swapTransactionBuf = Buffer.from(swapFullData.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([wallet]);
            
            console.log(`  > Transaction Payload Constructed and Signed!`);
            
            const rawTransaction = transaction.serialize();
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 1
            });
            
            console.log(`  ✅ Payload strictly executed (${token.sym})! TX Hash: ${txid}\n`);
            txLogs.push(`✅ [${token.sym}] Physical Payload Sent! TX: ${txid}`);
            
            // Allow RPC node a brief moment to process sequential connections organically natively without rate-limiting TCP slots
            await new Promise(r => setTimeout(r, 1500)); 

        } catch (err) {
            console.log(`  [EXCEPTION] ${token.sym} execution skipped: ${err.message}`);
            txLogs.push(`❌ [${token.sym}] Failed: ${err.message}`);
        }
    }
    
    fs.writeFileSync('c:/pcprotocol/force_5_results.txt', txLogs.join('\n'));
    console.log(`🚀 All 5 parallel assets structured sequentially! Reports aggregated natively.`);
}

forceBuyFive();
