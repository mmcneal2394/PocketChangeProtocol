import fs from 'fs/promises';
import { NextResponse } from 'next/server';

const JOURNAL_PATH = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl';

export async function GET() {
  try {
    const data = await fs.readFile(JOURNAL_PATH, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    // Return last 1000 trades
    return NextResponse.json(lines.slice(-1000));
  } catch (err) {
    return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
  }
}
