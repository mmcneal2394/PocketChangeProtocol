import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import fs from 'fs';
import dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

const JUPITER_API = 'https://public.jupiterapi.com';

// 1. Standard Node for Reading Chain State (Balances, Blockhashes, Priorities)
<<<<<<< HEAD
const READ_RPC = 'https://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';
=======
const READ_RPC = 'https://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

// 2. BloXroute Trader Node strictly for Writing (Submit/Warp constraints limit read commands yielding 405 errors)
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
    
    let optimalPriorityFee = 20000; // Downgraded absolute defaults natively
    try {
        const recentFees = await readConn.getRecentPrioritizationFees();
        if (recentFees && recentFees.length > 0) {
            const nonzeroFees = recentFees.map(f => f.prioritizationFee).filter(f => f > 0);
            if (nonzeroFees.length > 0) {
                const maxFee = Math.max(...nonzeroFees);
                optimalPriorityFee = Math.min(Math.floor(maxFee * 1.05), 50000); // 1.05x routing dynamic limit physically capped at 0.00005 SOL
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
    if (swapFullData.error) {
        console.error('🚨 [SWAP API ERROR]', swapFullData.error);
        return null;
    }
    const swapTransactionBuf = Buffer.from(swapFullData.swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    console.log(`[3] Instantly pushing atomic payload natively through Chainstack Trader UDP Nodes...`);
    const rawTransaction = transaction.serialize();
    
    try {
        // MUST hit Write connection for Warp Broadcast!
        const txid = await writeConn.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 2 });
        console.log(`✅ [${side}] Transaction Subsumed into UDP! TX ID: ${txid}`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${txid}`);

        console.log(`⏳ Awaiting physical network confirmation...`);
        // MUST hit Read connection to get standard chain consensus hashes!
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
             try {
                const txData = await readConn.getTransaction(txid, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
                if (txData && txData.meta) {
                    console.log(`   ⛽ [GAS PROFILER] Physical Base Network Fee: ${(txData.meta.fee / 1000000000).toFixed(6)} SOL (${txData.meta.fee} lamports)`);
                    console.log(`   ⚙️ [GAS PROFILER] Compute Units Consumed: ${txData.meta.computeUnitsConsumed}`);
                }
             } catch(e) {}
             return quoteData.outAmount; 
        }
    } catch(e) {
        console.error(`[${side}] RPC Error:`, e);
        return null;
    }
}

async function runHftPing() {
    const secretKeyStr = fs.readFileSync('./new_wallet.json', 'utf8');
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyStr)));
    
    // Explicit read/write node bifurcation
<<<<<<< HEAD
    const READ_WSS = 'wss://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';
=======
    const READ_WSS = 'wss://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
    const readConn = new Connection(READ_RPC, { wsEndpoint: READ_WSS, commitment: 'confirmed' });
    const writeConn = new Connection(WRITE_RPC, 'confirmed');

    const SOL = 'So11111111111111111111111111111111111111112';

    console.log('Active Wallet Base58 Pubkey:', wallet.publicKey.toString());
    
    let initialBalance = 0;
    try {
        const wsolAccs = await readConn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(SOL) });
        if (wsolAccs.value.length > 0) {
             const bInfo = await readConn.getTokenAccountBalance(wsolAccs.value[0].pubkey);
             initialBalance = parseInt(bInfo.value.amount);
        }
    } catch(e) {}
    console.log('Current Active Droplet WSOL SPL Balance:', initialBalance / 1000000000, 'WSOL');

    let rawBalance = 0;
    try {
        rawBalance = await readConn.getBalance(wallet.publicKey);
        console.log('💰 Current Active Native SOL Balance:', rawBalance / 1000000000, 'SOL');
    } catch(e) {}
    
    const EXECUTION_TARGETS = [
        { sym: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }
    ];
    
    // Explicit $0.25 testing parameters (1,500,000 lamports)
    const TRADE_SIZE_LAMPORTS = 1500000; 

    for (const target of EXECUTION_TARGETS) {
         console.log(`\n================================================================`);
         console.log(`📡 INITIATING DUAL-LEG DIAGNOSTIC SWEEP ON TARGET: ${target.sym}`);
         console.log(`================================================================`);
         
         const tokenReceivedVal = await buildAndSend(readConn, writeConn, wallet, SOL, target.mint, TRADE_SIZE_LAMPORTS, `HFT BUY [SOL -> ${target.sym}]`); 
         
         if (tokenReceivedVal) {
             console.log(`\n================================`);
             console.log(`💰 Quoted Execution Yield: ${tokenReceivedVal} ${target.sym} base units`);
             
             // Dynamic Dust Sync: Map exact physically received balance natively
             await new Promise(r => setTimeout(r, 2000)); // Brief network consensus lock
             let exactSellAmount = tokenReceivedVal;
             try {
                 const tAccs = await readConn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(target.mint) });
                 if (tAccs.value.length > 0) {
                      const bInfo = await readConn.getTokenAccountBalance(tAccs.value[0].pubkey);
                      if (bInfo.value.amount && parseInt(bInfo.value.amount) > 0) {
                           exactSellAmount = bInfo.value.amount;
                           console.log(`🧹 [DUST SYNC] Physical Wallet Target Balance Polled: ${exactSellAmount}`);
                      }
                 }
             } catch(e) {}

             console.log(`Executing immediate high-frequency reverse sell loop!`);
             console.log(`================================`);
             
             await buildAndSend(readConn, writeConn, wallet, target.mint, SOL, exactSellAmount, `HFT SELL [${target.sym} -> SOL]`);
         } else {
             console.log(`\n🛑 Buy sequence failed to settle on-chain for ${target.sym}. Advancing...`);
         }
         
         // 3-second explicit buffer interval to prevent aggressive connection timeouts natively at the Node level between rapid targets
         await new Promise(r => setTimeout(r, 3000));
    }
    
    let finalBalance = 0;
    try {
        const wsolAccs = await readConn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(SOL) });
        if (wsolAccs.value.length > 0) {
             const bInfo = await readConn.getTokenAccountBalance(wsolAccs.value[0].pubkey);
             finalBalance = parseInt(bInfo.value.amount);
        }
    } catch(e) {}
    
    console.log('\n================================');
    console.log('🏁 WSOL HFT DIAGNOSTIC COMPLETE.');
    console.log('Final Droplet Output WSOL Balance:', finalBalance / 1000000000, 'WSOL');
    console.log('Total Output Delta:', (finalBalance - initialBalance) / 1000000000, 'WSOL');
    
    // Explicit process kill explicitly required to detach hanging web3 WS listener objects
    process.exit(0);
}

runHftPing();
