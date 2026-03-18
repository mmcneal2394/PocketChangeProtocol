import { NextResponse } from 'next/server';
import Stripe from 'stripe';

// Initialize Stripe with dummy test secret key for MVP demonstration
// In production, this pulls from process.env.STRIPE_SECRET_KEY
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_51MockStripeSecretKeyForArbitraSaaS', {
  apiVersion: '2023-10-16' as any, // Target specific API version
});

// The standard base URL configuration
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function POST(req: Request) {
    try {
        const { planId, maxWallets } = await req.json();

        if (!planId) {
            return NextResponse.json({ error: "No plan selected." }, { status: 400 });
        }

        console.log(`[Stripe Checkout] Creating session for ${planId} Tier (Limit: ${maxWallets} Wallets)`);

        // Mocking user session since we don't have active JWT middleware enabled
        const userEmail = "admin@arbitrasaas.io"; 
        const userId = "tenant_uuid_mocked_123";

        // Logic for specific plan prices
        let priceData: any = {
            currency: 'usd',
            recurring: { interval: 'month' },
        };

        if (planId === 'PRO') {
            priceData.product_data = { name: 'ArbitraSaaS PRO Subscription', description: 'Up to 10 Parallel Arbitrage Wallets' };
            priceData.unit_amount = 14900; // $149.00
        } else if (planId === 'ENTERPRISE') {
            // High tier institutional SaaS
            priceData.product_data = { name: 'ArbitraSaaS ENTERPRISE Node', description: 'Up to 50 Parallel Arbitrage Wallets + Dedicated RPC' };
            priceData.unit_amount = 89900; // $899.00
        }

        // Generate the Stripe Checkout session
        // In a live environment, success_url triggers a Prisma webhook logic update to User.tier
        const session = {
            id: 'cs_test_' + Math.random().toString(36).substring(7),
            payment_method_types: ['card'],
            line_items: [ { price_data: priceData, quantity: 1 } ],
            mode: 'subscription',
            customer_email: userEmail,
            client_reference_id: userId,
            success_url: `${BASE_URL}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${BASE_URL}/billing?canceled=true`,
            url: `${BASE_URL}/billing?mock_checkout=true` // Overwrite for mock redirect
        };

        return NextResponse.json({ sessionId: session.id, url: session.url });

    } catch (err: any) {
        console.error('Error creating Stripe session:', err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
