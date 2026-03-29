import { NextResponse } from 'next/server';

export const runtime = 'edge'; 

// Forces Vercel to dynamically fetch this every time to bypass static hydration caching
export const dynamic = 'force-dynamic'; 

export async function GET() {
    try {
        // Proxy securely to the Droplet IP 
        const dropletResponse = await fetch('http://64.23.173.160:3002/api/initial', {
            // NextJS 14 cache buster
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!dropletResponse.ok) {
            return NextResponse.json({ error: 'Droplet connection failed' }, { status: 502 });
        }
        
        const data = await dropletResponse.json();
        return NextResponse.json(data);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
