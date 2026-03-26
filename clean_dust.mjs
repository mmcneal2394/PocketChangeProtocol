import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import fs from 'fs';

const JUPITER_API = 'https://public.jupiterapi.com';

<<<<<<< HEAD
const READ_RPC = 'https://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';
=======
const READ_RPC = 'https://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
const WRITE_RPC = 'https://nd-622-626-774.p2pify.com/89d5bb214e0ab0b5b25397cd9ca79d95';

async function buildAndSend(readConn, writeConn, wallet, inputMint, outputMint, amount, side) {
    console.log(`\n⚡ Constructing ${side} payload via BloXroute HFT Pipeline...`);
    
    console.log(`[1] Quoting payload execution parameter routing...`);
    const quoteRes = await fetch(`${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=200`);
    const quoteData = await quoteRes.json();
    
    if (quoteData.error) {
         console.error('[QUOTE API ERROR]', quoteData.error);
         return null;
    }
    
    let optimalPriorityFee = 250000; 
    try {
        const recentFees = await readConn.getRecentPrioritizationFees();
        if (recentFees && recentFees.length > 0) {
            const nonzeroFees = recentFees.map(f => f.prioritizationFee).filter(f => f > 0);
            if (nonzeroFees.length > 0) {
                const maxFee = Math.max(...nonzeroFees);
                optimalPriorityFee = Math.min(Math.floor(maxFee * 2.5), 5000000); 
            }
        }
    } catch(e) {}
    
    console.log(`[2] Compiling Payload with ${optimalPriorityFee} Lamports ultra-aggressive frontrun MEV bid...`);
    const swapFullRes = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: optimalPriorityFee
        })
    });
    
    const swapFullData = await swapFullRes.json();
    const swapTransactionBuf = Buffer.from(swapFullData.swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    console.log(`[3] Instantly pushing atomic payload natively through Chainstack Trader UDP Nodes...`);
    const rawTransaction = transaction.serialize();
    
    try {
        const txid = await writeConn.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 2 });
        console.log(`✅ [${side}] Transaction Subsumed into UDP! TX ID: ${txid}`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${txid}`);

        console.log(`⏳ Awaiting physical network confirmation...`);
        const latestBlockHash = await readConn.getLatestBlockhash();
        const confirmation = await readConn.confirmTransaction({
             blockhash: latestBlockHash.blockhash,
             lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
             signature: txid
        }, 'confirmed');

        if (confirmation.value.err) {
             console.error(`❌ [${side}] Transaction failed at validators:`, confirmation.value.err);
             return null;
        } else {
             console.log(`✨ [${side}] TRANSACTION CONFIRMED ON SOLANA MAINNET AT BLOCK `, await readConn.getSlot());
             return quoteData.outAmount; 
        }
    } catch(e) {
        console.error(`[${side}] RPC Error:`, e);
        return null;
    }
}

async function runDustCleanup() {
    const secretKeyStr = fs.readFileSync('./new_wallet.json', 'utf8');
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyStr)));
    
<<<<<<< HEAD
    const READ_WSS = 'wss://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';
=======
    const READ_WSS = 'wss://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
    const readConn = new Connection(READ_RPC, { wsEndpoint: READ_WSS, commitment: 'confirmed' });
    const writeConn = new Connection(WRITE_RPC, 'confirmed');

    console.log('Active Wallet Base58 Pubkey:', wallet.publicKey.toString());
    const SOL = 'So11111111111111111111111111111111111111112';

    const EXECUTION_TARGETS = [
        { sym: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
        { sym: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" }
    ];

    for (const target of EXECUTION_TARGETS) {
         console.log(`\n================================================================`);
         console.log(`📡 INITIATING DUST LIQUIDATION SWEEP ON TARGET: ${target.sym}`);
         console.log(`================================================================`);
         
         try {
             let exactSellAmount = null;
             const tAccs = await readConn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(target.mint) });
             if (tAccs.value.length > 0) {
                  const bInfo = await readConn.getTokenAccountBalance(tAccs.value[0].pubkey);
                  if (bInfo.value.amount && parseInt(bInfo.value.amount) > 0) {
                       exactSellAmount = bInfo.value.amount;
                       console.log(`🧹 [DUST SYNC] Physical Wallet Target Balance Polled: ${exactSellAmount}`);
                  }
             }
             
             if (exactSellAmount) {
                 await buildAndSend(readConn, writeConn, wallet, target.mint, SOL, exactSellAmount, `HFT SELL [${target.sym} -> SOL DUST SWEEP]`);
             } else {
                 console.log(`No physical dust actively detected for ${target.sym}. Zero balance resolved.`);
             }
         } catch(e) {}
         
         await new Promise(r => setTimeout(r, 4000));
    }
    
    console.log('\n================================');
    console.log('🏁 HFT DUST DIAGNOSTIC COMPLETE.');
}

runDustCleanup();
