import fetch from 'cross-fetch';

async function test0x() {
    const url = "https://solana.api.0x.org/swap/v1/swap-instructions?sellToken=So11111111111111111111111111111111111111112&buyToken=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&sellAmount=100000000&slippagePercentage=0.01&taker=DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj";
    const res = await fetch(url, {
        headers: {
            '0x-api-key': '3155a25e-0542-4a02-b4da-a9343131394d'
        }
    });

    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response:", text);
}
test0x();
