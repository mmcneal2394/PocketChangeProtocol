import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import Redis from 'ioredis';
import { config } from 'dotenv';

config();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const redis = new Redis(REDIS_URL);

// Whitelist of tunable parameters
const ALLOWED_KEYS = [
  'MIN_SPREAD_PCT',
  'MIN_LIQUIDITY_USD',
  'MAX_SLIPPAGE_BPS',
  'PRIORITY_FEE_MICROLAMPORTS',
  'TRADE_COOLDOWN_MS',
  'BUY_AMOUNT_USDC',
  'BUY_AMOUNT_SOL',
];

const ENV_PATH = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env';

export async function POST(request: Request) {
  try {
    const { updates } = await request.json();
    if (!updates || typeof updates !== 'object') {
      return NextResponse.json({ error: 'Invalid updates object' }, { status: 400 });
    }

    // 1. Update .env file
    let envContent = await fs.readFile(ENV_PATH, 'utf-8').catch(() => '');
    const lines = envContent.split('\n');
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      const newLine = `${key}=${value}`;
      const index = lines.findIndex(line => line.startsWith(`${key}=`));
      if (index !== -1) {
        lines[index] = newLine;
      } else {
        lines.push(newLine);
      }
    }
    await fs.writeFile(ENV_PATH, lines.join('\n'));

    // 2. Publish to Redis so agents can reload without restart
    await redis.publish('CONFIG_UPDATE', JSON.stringify(updates));

    return NextResponse.json({ success: true, applied: updates });
  } catch (err) {
    console.error('Config API error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
