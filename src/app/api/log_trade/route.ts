import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        
        const dbPath = path.join(process.cwd(), 'trades.json');
        let logs = [];
        try {
            logs = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        } catch(e) {}
        
        const log = {
            id: "tx_" + Date.now() + "_" + Math.floor(Math.random()*1000),
            userId: "00000000-0000-0000-0000-000000000001",
            walletId: body.walletPubkey,
            status: body.status,
            profitAmt: body.profitAmt,
            route: body.route,
            txHash: body.txHash,
            createdAt: new Date().toISOString()
        };

        logs.push(log);
        fs.writeFileSync(dbPath, JSON.stringify(logs, null, 2));

        return NextResponse.json({ success: true, log });
    } catch(e: any) {
        console.error("Trade Log Error: ", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
