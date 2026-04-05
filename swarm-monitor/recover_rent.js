require('dotenv').config();
const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, createCloseAccountInstruction } = require('@solana/spl-token');
const fs = require('fs');

const c = new Connection(process.env.RPC_ENDPOINT, 'confirmed');

// Load wallet from keypair file
const keypairPath = process.env.WALLET_KEYPAIR_PATH;
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function main() {
  const mode = process.argv[2] || 'scan'; // 'scan' or 'close'
  
  const nativeBal = await c.getBalance(wallet.publicKey);
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Native SOL:', (nativeBal / 1e9).toFixed(9));
  
  const accts = await c.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  
  let wsolBal = 0;
  let closeable = [];
  let totalRent = 0;
  
  console.log('\nTotal ATAs found:', accts.value.length);
  console.log('---');
  
  for (const a of accts.value) {
    const data = a.account.data;
    const mint = new PublicKey(data.slice(0, 32)).toBase58();
    const amount = data.readBigUInt64LE(64);
    const rentLamports = a.account.lamports;
    const isWSOL = mint === WSOL_MINT;
    
    if (isWSOL) {
      wsolBal = Number(amount) / 1e9;
      console.log('  WSOL ATA:', a.pubkey.toBase58().slice(0,20) + '...', '|', wsolBal.toFixed(6), 'SOL | KEEP');
    } else if (Number(amount) === 0) {
      closeable.push({ pubkey: a.pubkey, mint, rentLamports });
      totalRent += rentLamports;
      console.log('  EMPTY:', a.pubkey.toBase58().slice(0,16) + '...', '| mint:', mint.slice(0,10) + '...', '| rent:', (rentLamports/1e9).toFixed(6), 'SOL');
    } else {
      closeable.push({ pubkey: a.pubkey, mint, rentLamports, hasDust: true, amount: Number(amount) });
      totalRent += rentLamports;
      console.log('  DUST: ', a.pubkey.toBase58().slice(0,16) + '...', '| mint:', mint.slice(0,10) + '...', '|', Number(amount), 'tokens | rent:', (rentLamports/1e9).toFixed(6), 'SOL');
    }
  }
  
  console.log('\n=== SUMMARY ===');
  console.log('Native SOL:', (nativeBal / 1e9).toFixed(9));
  console.log('WSOL:', wsolBal.toFixed(9));
  console.log('Closeable ATAs:', closeable.length);
  console.log('Recoverable rent:', (totalRent / 1e9).toFixed(6), 'SOL ($' + (totalRent / 1e9 * 135).toFixed(2) + ')');
  console.log('TRUE TOTAL (after recovery):', ((nativeBal / 1e9) + wsolBal + (totalRent / 1e9)).toFixed(6), 'SOL');
  
  if (mode === 'close' && closeable.length > 0) {
    console.log('\n=== CLOSING', closeable.length, 'ATAs ===');
    
    const batchSize = 8;
    let closed = 0;
    let recovered = 0;
    
    for (let i = 0; i < closeable.length; i += batchSize) {
      const batch = closeable.slice(i, i + batchSize);
      const tx = new Transaction();
      
      for (const ata of batch) {
        tx.add(createCloseAccountInstruction(
          ata.pubkey,
          wallet.publicKey,
          wallet.publicKey,
          [],
          TOKEN_PROGRAM_ID
        ));
      }
      
      try {
        const sig = await sendAndConfirmTransaction(c, tx, [wallet], { skipPreflight: true });
        closed += batch.length;
        const batchRent = batch.reduce((sum, a) => sum + a.rentLamports, 0);
        recovered += batchRent;
        console.log('  Batch', Math.floor(i/batchSize)+1 + ':', 'closed', batch.length, 'ATAs |', (batchRent/1e9).toFixed(6), 'SOL recovered | tx:', sig.slice(0,25) + '...');
      } catch (e) {
        console.error('  Batch', Math.floor(i/batchSize)+1, 'FAILED:', e.message.slice(0,120));
        // Try individually for failed batches
        for (const ata of batch) {
          const soloTx = new Transaction();
          soloTx.add(createCloseAccountInstruction(ata.pubkey, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID));
          try {
            await sendAndConfirmTransaction(c, soloTx, [wallet], { skipPreflight: true });
            closed++;
            recovered += ata.rentLamports;
            console.log('    Solo close:', ata.pubkey.toBase58().slice(0,16) + '...', 'OK');
          } catch (e2) {
            console.log('    Solo close:', ata.pubkey.toBase58().slice(0,16) + '...', 'SKIP (has tokens)');
          }
        }
      }
    }
    
    const newBal = await c.getBalance(wallet.publicKey);
    console.log('\n=== RESULT ===');
    console.log('Closed:', closed, '/', closeable.length, 'ATAs');
    console.log('Recovered:', (recovered / 1e9).toFixed(6), 'SOL');
    console.log('New native SOL:', (newBal / 1e9).toFixed(9));
    console.log('New total:', ((newBal / 1e9) + wsolBal).toFixed(6), 'SOL');
  }
}
main().catch(console.error);
