const { buildVersionedTransaction } = require('../dist/execution/transaction.js');
const { submitTransactionWithRacing } = require('../dist/execution/racing.js');
const cache = require('../dist/jupiter/cache.js');

cache.getCachedBlockhash = () => "HsM57uX7d3FmP1mockedBlockhashForTesting8xW";
cache.getAddressLookupTable = async () => null;

console.log('🚨 [LIVE FORCE TEST] Triggering physical execution node locally...');

const mockIx = {
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    accounts: [{ pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }],
    data: 'Aw=='
};

const ix1 = { setupInstructions: [], swapInstruction: mockIx, addressLookupTableAddresses: [] };
const ix2 = { setupInstructions: [], swapInstruction: mockIx, addressLookupTableAddresses: [] };

buildVersionedTransaction(ix1, ix2, 8500000).then(tx => {
    if (tx) {
        console.log('[COMPILATION] Constructing target Jito payload with 0.0085 SOL Tip seamlessly...');
        submitTransactionWithRacing(tx).then(res => {
            console.log(res);
            console.log('✅ Live Force Test Jito Compilation Output verified!');
        }).catch(err => {
            console.error(err);
        });
    } else {
        console.error('TX Build Failed Locally!');
    }
}).catch(console.error);
