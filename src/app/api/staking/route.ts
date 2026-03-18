import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');

  if (!wallet) return NextResponse.json({ error: "Wallet pubkey required." }, { status: 400 });

  try {
    const configPath = path.join(process.cwd(), 'src', 'config.yaml');
    const file = fs.readFileSync(configPath, 'utf8');
    const config = yaml.parse(file);

    const isSimulated = config?.data_sources?.price_feed?.mode === 'simulated';

    if (isSimulated) {
       return NextResponse.json({
         stakedBalance: 5000,
         yieldEarned: 12.50,
         multiplier: 1.25,
         mode: "simulated"
       });
    }

    // Live mode placeholder pending anchor contract integration
    return NextResponse.json({
       stakedBalance: 0,
       yieldEarned: 0,
       multiplier: 1.0,
       mode: "live"
    });

  } catch (error) {
    return NextResponse.json({ error: "Failed to load config" }, { status: 500 });
  }
}
