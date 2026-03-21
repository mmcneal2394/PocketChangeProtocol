import fetch from 'cross-fetch';

async function testQn() {
    const url = "https://jupiter-swap-api.quiknode.pro/3155a25e-0542-4a02-b4da-a9343131394d/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50";
    const res = await fetch(url);
    console.log("Status:", res.status);
    const json = await res.json();
    console.log("Response:", Object.keys(json));
}
testQn();
