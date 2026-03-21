import fetch from 'cross-fetch';

async function testJup() {
    const url = "https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50";
    const res = await fetch(url, {
        headers: { 'x-api-key': '3155a25e-0542-4a02-b4da-a9343131394d' }
    });
    console.log("Status:", res.status);
    const json = await res.json();
    console.log("Response:", json);
}
testJup();
