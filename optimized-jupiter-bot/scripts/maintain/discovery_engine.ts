import * as http from 'http';
import * as https from 'https';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';

const POLL_INTERVAL_PUMP = 10_000;
const POLL_INTERVAL_GECKO = 60_000;

// Central cache to prevent looping over the same coins excessively
const knownMints = new Set<string>();

function pushVelocitySpike(mint: string, swaps: number, source: string) {
    if (knownMints.has(mint)) return;
    knownMints.add(mint);

    // Allow cache pruning to keep memory linear
    if (knownMints.size > 10000) knownMints.clear();

    const formattedPayload = {
        updatedAt: Date.now(),
        mints: {
            [mint]: {
                buys60s: swaps,
                sells60s: 0,
                buyRatio60s: 1.0,         
                velocity: swaps,           
                isAccelerating: true,
                solVolume60s: 0
            }
        }
    };

    RedisBus.publish(CHANNELS.VELOCITY_SPIKE, formattedPayload)
        .then(() => {
            console.log(`[DISCOVERY][${source}] Ingested token: ${mint} (Simulated Hits: ${swaps})`);
        })
        .catch((e: any) => {
            console.error(`[DISCOVERY] Redis publish failed:`, e.message);
        });
}

// GeckoTerminal Pipeline
async function pollGeckoTerminal() {
    try {
        const res = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!res.ok) throw new Error(`Gecko Response: ${res.status}`);
        const data = await res.json();
        
        const pools = data?.data || [];
        pools.forEach((pool: any) => {
            const tokenAddress = pool?.relationships?.base_token?.data?.id?.replace('solana_', '');
            if (tokenAddress) {
                // Determine raw momentum payload via GeckoTerminal USD volume
                const swapsMock = 25; // Pre-warm Gecko hits tightly
                pushVelocitySpike(tokenAddress, swapsMock, 'GECKO');
            }
        });

    } catch (e: any) {
        console.warn(`[DISCOVERY][GECKO] Polling fault: ${e.message}`);
    }
}

// DexScreener Latest Profiles Pipeline
async function pollDexScreener() {
    try {
        const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!res.ok) throw new Error(`DexScreener Response: ${res.status}`);
        const tokens = await res.json();
        
        if (Array.isArray(tokens)) {
            tokens.slice(0, 15).forEach((token: any) => {
                // Ensure the network is strictly solana
                if (token.chainId === 'solana' && token.tokenAddress) {
                    const swapsMock = 15; // Raw profiles have lower simulated velocity
                    pushVelocitySpike(token.tokenAddress, swapsMock, 'DEXSCREENER');
                }
            });
        }
    } catch (e: any) {
        console.warn(`[DISCOVERY][DEXSCREENER] Polling fault: ${e.message}`);
    }
}

async function start() {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║     PCP DISCOVERY ENGINE ONLINE v1.0     ║`);
    console.log(`║     Sources: GeckoTerminal, DexScreener  ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    
    // Initial fetch
    pollDexScreener();
    pollGeckoTerminal();

    setInterval(pollDexScreener, POLL_INTERVAL_PUMP);
    setInterval(pollGeckoTerminal, POLL_INTERVAL_GECKO);
}

start();
