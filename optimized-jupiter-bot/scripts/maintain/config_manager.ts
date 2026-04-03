import Redis from 'ioredis';
import fs from 'fs/promises';
import path from 'path';
import { config } from 'dotenv';

config();

const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
// Remote path configured for droplet pipeline standard
const ENV_PATH = process.env.ENV_PATH || '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env';

export interface SwarmConfig {
  MIN_SPREAD_PCT: number;
  MIN_LIQUIDITY_USD: number;
  MAX_SLIPPAGE_BPS: number;
  PRIORITY_FEE_MICROLAMPORTS: number;
  TRADE_COOLDOWN_MS: number;
  BUY_AMOUNT_USDC: number;
  BUY_AMOUNT_SOL: number;
}

function loadFromEnv(): SwarmConfig {
  return {
    MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '1.5'),
    MIN_LIQUIDITY_USD: parseFloat(process.env.MIN_LIQUIDITY_USD || '5000'),
    MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS || '300'),
    PRIORITY_FEE_MICROLAMPORTS: parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '50000'),
    TRADE_COOLDOWN_MS: parseInt(process.env.TRADE_COOLDOWN_MS || '60000'),
    BUY_AMOUNT_USDC: parseFloat(process.env.BUY_AMOUNT_USDC || '10'),
    BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || '0.05'),
  };
}

// In‑memory store
let currentConfig: SwarmConfig = loadFromEnv();
let redis: Redis | null = null;

export async function initConfigManager() {
  redis = new Redis(REDIS_URL);
  await redis.subscribe('config:update');
  redis.on('message', async (channel, message) => {
    if (channel === 'config:update') {
      try {
        const updates = JSON.parse(message);
        let changed = false;
        for (const [key, value] of Object.entries(updates)) {
          if (key in currentConfig) {
            (currentConfig as any)[key] = value;
            changed = true;
          }
        }
        if (changed) {
          console.log('[CONFIG] 🔁 Live update applied:', updates);
          // Persist to .env (disabled locally on windows since ENV_PATH points to droplet)
          if (!process.env.OS?.toLowerCase().includes("windows")) {
              await persistConfig(updates);
          }
        }
      } catch (err) {
        console.error('[CONFIG] Error processing update:', err);
      }
    }
  });
  console.log('[CONFIG] Manager initialized, listening for updates');
}

async function persistConfig(updates: Partial<SwarmConfig>) {
  try {
    let envContent = await fs.readFile(ENV_PATH, 'utf-8').catch(() => '');
    const lines = envContent.split('\n');
    for (const [key, value] of Object.entries(updates)) {
      const newLine = `${key}=${value}`;
      const index = lines.findIndex(line => line.startsWith(`${key}=`));
      if (index !== -1) lines[index] = newLine;
      else lines.push(newLine);
    }
    await fs.writeFile(ENV_PATH, lines.join('\n'));
  } catch (err) {
    console.warn('[CONFIG] Could not persist .env', err);
  }
}

export function getConfig(): SwarmConfig {
  // Return a fresh copy to avoid accidental mutation
  return { ...currentConfig };
}

// Graceful shutdown
export async function closeConfigManager() {
  if (redis) {
      await redis.unsubscribe('config:update').catch(() => {});
      await redis.quit();
  }
}
