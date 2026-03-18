import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

async function verifyJitoConnection() {
    console.log('==========================================');
    console.log('🟢 INITIATING JITO NY NODE CONNECTION TEST (MAINNET)');
    console.log('==========================================');
    
    // Using ABPR Private Key directly for test execution
    const wallet = Keypair.fromSecretKey(bs58.decode('2Z1gEB9B4vAoxhTZt1DzrmVGjJxkN54MwoAarmNp8h69KDKY6ECFmPGxcwNUa9Pj8gctt7wvMeRYUaqo74fJYNAt'));
    console.log(`✅ Loaded ABPR Wallet: ${wallet.publicKey.toString()}`);
    
    // Connect to Mainnet Beta
    const rpcUrl = 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    console.log(`✅ Bound to Solana RPC: api.mainnet-beta.solana.com`);
    
    try {
        // Jito Tip Account (using a standard active validator tip account)
        const tipAccount = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

        const instructions = [
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: 0
            }),
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: tipAccount,
                lamports: 1000 // Minimal tip for ping/validation testing
            })
        ];
        
        console.log('   -> Querying latest blockhash...');
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message();
        
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        
        const atomicBase58 = bs58.encode(transaction.serialize());
        console.log('   -> Bundle serialized successfully.');

        const jitoPayload = {
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [[atomicBase58]] 
        };

        console.log('   -> Routing payload to Jito NY Block Engine...');
        const jitoRes = await fetch('https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jitoPayload)
        });
        
        const data = await jitoRes.json();
        
        console.log('\n==========================================');
        if (data.result) {
             console.log(`✅ [JITO SUCCESS] Server returned active bundle UUID: ${data.result}`);
        } else if (data.error) {
             console.log(`❌ [JITO REJECTED] Jito returned an API error: ${JSON.stringify(data.error)}`);
        } else {
             console.log(`⚠️ [NETWORK UNKNOWN] Unrecognized response from Jito:`, data);
        }
        console.log('==========================================');
        
    } catch (e) {
        console.error('❌ Fatal network interrupt:', e.message);
    }
}
verifyJitoConnection();
