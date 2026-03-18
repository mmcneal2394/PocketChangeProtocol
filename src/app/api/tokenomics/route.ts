import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

// In-memory simulation state for other events
let totalFeesClaimed = 25400;

let lastFetchTime = 0;
let cachedSupply = 0;

export async function GET() {
  try {
    let circulatingSupply = 1000000000;
    
    // Fetch real supply from Solana Mainnet (cache for 10s to avoid rate limits)
    try {
        const now = Date.now();
        if (now - lastFetchTime > 10000) {
            // Using a public RPC, in prod we would use our Helius or QuickNode RPC
            const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            const tokenPubKey = new PublicKey('4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS');
            const supplyRes = await connection.getTokenSupply(tokenPubKey);
            if (supplyRes.value.uiAmount !== null) {
                cachedSupply = supplyRes.value.uiAmount;
                lastFetchTime = now;
            }
        }
        if (cachedSupply > 0) {
            circulatingSupply = cachedSupply;
        }
    } catch (rpcErr) {
        console.warn("RPC Supply fetch failed, using cached/default", rpcErr);
        if (cachedSupply > 0) circulatingSupply = cachedSupply;
    }

    const totalBurned = 1000000000 - circulatingSupply;
    
    // Mock fee increments for UI demo feel
    if (Math.random() > 0.9) {
        totalFeesClaimed += Math.floor(Math.random() * 800) + 100;
    }
    
    const recentActions = [
        {
            id: `evt_${Date.now()}_1`,
            type: "burn",
            title: "🔥 Deflationary Burn",
            amount: `Live Synced Syncing...`,
            time: "Real-time",
            hash: `tx_...`
        },
        {
            id: `evt_${Date.now()}_2`,
            type: "fee",
            title: "💰 Admin Fee Claim",
            amount: `$${(Math.floor(Math.random() * 1000) + 200).toLocaleString()} USDC`,
            time: "2 mins ago",
            hash: `tx_${Math.random().toString(36).substring(7)}`
        }
    ];

    const allocations = [
        { label: "Vault Staking Rewards", percentage: 50, color: "#00FFaa" },
        { label: "Treasury", percentage: 30, color: "#00ccff" },
        { label: "Founder", percentage: 20, color: "#ff0080" },
    ];

    return NextResponse.json({
      maxSupply: 1000000000,
      circulatingSupply,
      totalBurned,
      totalFeesClaimed,
      recentActions,
      allocations
    });

  } catch (error) {
    console.error("Tokenomics API Error:", error);
    return NextResponse.json({ error: "Failed to generate tokenomics data" }, { status: 500 });
  }
}
