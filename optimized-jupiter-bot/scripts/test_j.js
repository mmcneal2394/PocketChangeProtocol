const { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

async function run() {
    const wallet = Keypair.generate();
    
    // Create purely a tip transaction to isolate Jito's parser
    const tipIx = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiCRKbkciwEMKqQk9w3VjD"),
        lamports: 2000000,
    });

    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: "11111111111111111111111111111111", // Any string works for Jito preflight format validation
        instructions: [tipIx],
    }).compileToV0Message();

    console.log("Static keys:", messageV0.staticAccountKeys.map(k=>k.toBase58()));
    console.log("Header:", messageV0.header);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    const txBase58 = bs58.encode(transaction.serialize());
    
    console.log("Sending payload...");
    const response = await fetch("https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", {
        method: "POST", headers: {"Content-Type": "application/json"}, 
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[txBase58]] })
    });
    console.log("RESPONSE:", await response.text());
}
run();
