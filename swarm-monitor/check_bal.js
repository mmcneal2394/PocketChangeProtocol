require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const c = new Connection(process.env.RPC_ENDPOINT);
const w = 'DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13';
async function main() {
  const bal = await c.getBalance(new PublicKey(w));
  console.log('Native SOL:', bal / 1e9);
  // Check WSOL
  const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
  const accts = await c.getTokenAccountsByOwner(new PublicKey(w), { programId: TOKEN_PROGRAM_ID });
  let wsol = 0;
  for (const a of accts.value) {
    const data = a.account.data;
    const mint = new PublicKey(data.slice(0, 32)).toBase58();
    if (mint === 'So11111111111111111111111111111111111111112') {
      const amount = data.readBigUInt64LE(64);
      wsol = Number(amount) / 1e9;
    }
  }
  console.log('WSOL:', wsol);
  console.log('Total:', (bal / 1e9 + wsol).toFixed(4));
}
main();
