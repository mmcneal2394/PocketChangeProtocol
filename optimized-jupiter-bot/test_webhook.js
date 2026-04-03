fetch('http://127.0.0.1:3001/velocity-spike', {
    method: 'POST',
    body: JSON.stringify({mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', swaps: 28, timestamp: Date.now()}),
    headers: { 'Content-Type': 'application/json' }
}).then(r => r.text()).then(console.log).catch(console.error);
