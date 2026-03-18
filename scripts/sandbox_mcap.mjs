import fetch from 'node-fetch';

async function testMCap() {
    const mint = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // WIF
    
    console.log("Testing RugCheck...");
    const rc = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    const data = await rc.json();
    console.log("Rugcheck markets:", data.markets ? data.markets.map(m => m.lp) : "none");
    
    console.log("Testing DexScreener...");
    const ds = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const dsData = await ds.json();
    if (dsData.pairs && dsData.pairs.length > 0) {
        console.log("DexScreener FDV:", dsData.pairs[0].fdv, "MarketCap:", dsData.pairs[0].marketCap);
    }
}
testMCap();
