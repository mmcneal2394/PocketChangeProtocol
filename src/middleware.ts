import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

// In-memory fallback if Redis is not configured
const inMemoryFallbackMap = new Map<string, { count: number; expiresAt: number }>();
const RATE_LIMIT_COUNT = 60; 
const RATE_LIMIT_WINDOW_MS = 60 * 1000; 

// Initialize Upstash Redis & Ratelimit conditionally
let redisLimit: Ratelimit | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // Create a new ratelimiter, that allows 60 requests per 60 seconds
  redisLimit = new Ratelimit({
    redis: redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT_COUNT, "60 s"),
    analytics: true,
  });
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api')) {
    const forwardedFor = request.headers.get('x-forwarded-for');
    const ip = request.headers.get('x-real-ip') || (forwardedFor ? forwardedFor.split(',').pop()?.trim() : null) || '127.0.0.1'; 
    
    // 0. OFAC Compliance Geofencing (Vector 1: Geographic Edge Blocking)
    const country = request.headers.get('x-vercel-ip-country');
    // Sanctioned jurisdictions requiring total service blackout
    const BLOCKED_COUNTRIES = ["KP", "IR", "SY", "CU", "RU", "SD", "BY"];

    if (country && BLOCKED_COUNTRIES.includes(country.toUpperCase())) {
      console.warn(`[Compliance] Connection refused from restricted OFAC jurisdiction: ${country} (IP: ${ip})`);
      return new NextResponse(
        JSON.stringify({ error: "Unavailable For Legal Reasons", message: "PocketChange Protocol algorithms are legally restricted in your jurisdiction per US Treasury OFAC regulations." }),
        { status: 451, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 1. Enterprise Redis Distributed Rate Limiter
    if (redisLimit) {
        const { success } = await redisLimit.limit(`ratelimit_${ip}`);
        
        if (!success) {
            console.warn(`[Security] Global Redis Rate Limit Exceeded by IP: ${ip}`);
            return new NextResponse(
              JSON.stringify({ error: "Too Many Requests", message: "API rate limit exceeded across edge network. Please try again later." }),
              { status: 429, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return NextResponse.next();
    }

    // 2. Fallback: In-memory tracker
    const now = Date.now();
    for (const [key, value] of inMemoryFallbackMap.entries()) {
      if (now > value.expiresAt) {
        inMemoryFallbackMap.delete(key);
      }
    }

    const currentRecord = inMemoryFallbackMap.get(ip);

    if (!currentRecord) {
      inMemoryFallbackMap.set(ip, {
        count: 1,
        expiresAt: now + RATE_LIMIT_WINDOW_MS
      });
    } else {
      if (currentRecord.count >= RATE_LIMIT_COUNT) {
        console.warn(`[Security] Local Rate Limit Exceeded by IP: ${ip} (Warning: Redis is missing)`);
        return new NextResponse(
          JSON.stringify({ error: "Too Many Requests", message: "API rate limit exceeded. Please try again later." }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        currentRecord.count += 1;
        inMemoryFallbackMap.set(ip, currentRecord);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
