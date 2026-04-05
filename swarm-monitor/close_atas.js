require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const conn = new Connection(process.env.RPC_ENDPOINT);
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1));

async function main() {
  console.log('Wallet:', wallet.publicKey.toBase58());
  
  const accounts = await conn.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  console.log(`Total token accounts: ${accounts.value.length}`);
  
  const empty = [];
  for (const acct of accounts.value) {
    const amount = acct.account.data.readBigUInt64LE(64);
    if (amount === 0n) {
      empty.push(acct.pubkey);
    }
  }
  
  console.log(`Empty (closeable): ${empty.length}`);
  console.log(`Recoverable rent: ~${(empty.length * 0.00203928).toFixed(4)} SOL`);
  
  if (empty.length === 0) {
    console.log('Nothing to close.');
    return;
  }
  
  // Close in batches of 20 (TX size limit)
  const BATCH = 20;
  let closed = 0;
  let recovered = 0;
  
  for (let i = 0; i < empty.length; i += BATCH) {
    const batch = empty.slice(i, i + BATCH);
    const tx = new Transaction();
    
    for (const pubkey of batch) {
      tx.add(createCloseAccountInstruction(
        pubkey,
        wallet.publicKey, // destination for rent
        wallet.publicKey, // authority
        [],
        TOKEN_PROGRAM_ID
      ));
    }
    
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
      closed += batch.length;
      recovered += batch.length * 0.00203928;
      console.log(`Batch ${Math.floor(i/BATCH)+1}: Closed ${batch.length} accounts | TX: ${sig.slice(0, 20)}...`);
    } catch (e) {
      console.error(`Batch ${Math.floor(i/BATCH)+1} failed:`, e.message.slice(0, 100));
      // Try individually
      for (const pubkey of batch) {
        try {
          const tx2 = new Transaction();
          tx2.add(createCloseAccountInstruction(pubkey, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID));
          const sig = await sendAndConfirmTransaction(conn, tx2, [wallet], { commitment: 'confirmed' });
          closed++;
          recovered += 0.00203928;
          console.log(`  Individual close: ${pubkey.toBase58().slice(0, 12)}... OK`);
        } catch (e2) {
          console.error(`  Skip ${pubkey.toBase58().slice(0, 12)}... (${e2.message.slice(0, 50)})`);
        }
      }
    }
  }
  
  console.log(`\nDone! Closed ${closed}/${empty.length} accounts`);
  console.log(`Recovered: ~${recovered.toFixed(4)} SOL`);
  
  // Final balance
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(`New balance: ${(bal / 1e9).toFixed(4)} SOL`);
}

main().catch(e => console.error('Fatal:', e.message));
