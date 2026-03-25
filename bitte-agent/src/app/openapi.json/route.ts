import { NextRequest, NextResponse } from 'next/server';

// Canonical OpenAPI spec served at /openapi.json
// This is what Bitte indexes when registering the agent.

const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || 'https://pcp-agent.vercel.app';

export async function GET(req: NextRequest) {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'PocketChange Protocol — Solana DeFi Intelligence',
      description:
        'Real-time Solana DeFi analytics: arbitrage windows, token momentum scanning, ' +
        'alpha signals, and smart contract security audits. All data sourced from ' +
        'Jupiter lite-api, DexScreener, and Helius RPC.',
      version: '1.0.0',
    },
    servers: [{ url: DEPLOYMENT_URL }],
    'x-mb': {
      'account-id': 'pocketchange.near',
      assistant: {
        name: 'PocketChange Protocol Agent',
        description:
          'Solana DeFi intelligence: arb windows, token momentum, alpha signals, code audits.',
        instructions:
          'You are the PocketChange Protocol intelligence agent. You specialize in Solana DeFi. ' +
          'When asked about trading opportunities, call get-arb-windows or get-alpha-signals. ' +
          'When asked about trending tokens, call get-token-scan. ' +
          'When asked to audit code, call post-code-audit with the code content. ' +
          'Always present numbers with context: bps = basis points (1 bps = 0.01%). ' +
          'Never give financial advice. Present data factually. ' +
          'When showing arb windows, always mention that the wallet must be funded to execute.',
        tools: [
          { type: 'submit-query' },
          { type: 'render-chart' },
        ],
        categories: ['DeFi', 'Solana', 'Analytics', 'Security', 'MEV', 'Arbitrage'],
        version: '1.0.0',
      },
    },
    paths: {
      '/api/token-scan': {
        get: {
          operationId: 'get-token-scan',
          summary: 'Scan for high-momentum Solana tokens',
          description:
            'Fetches new and trending Solana tokens from DexScreener, scores them on ' +
            'liquidity, volume, age, and momentum, and returns ranked candidates for arb analysis.',
          parameters: [
            {
              name: 'minLiq',
              in: 'query',
              schema: { type: 'number', default: 8000 },
              description: 'Minimum liquidity in USD',
            },
            {
              name: 'minVol',
              in: 'query',
              schema: { type: 'number', default: 20000 },
              description: 'Minimum 24h volume in USD',
            },
            {
              name: 'maxAge',
              in: 'query',
              schema: { type: 'number', default: 48 },
              description: 'Maximum token age in hours',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 10, maximum: 25 },
              description: 'Number of results to return',
            },
          ],
          responses: {
            '200': {
              description: 'Ranked token candidates',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tokens: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            mint:             { type: 'string' },
                            symbol:           { type: 'string' },
                            score:            { type: 'number' },
                            liquidity_usd:    { type: 'number' },
                            volume_usd_24h:   { type: 'number' },
                            age_hours:        { type: 'number' },
                            price_change_24h: { type: 'number' },
                            source:           { type: 'string' },
                          },
                        },
                      },
                      scanned_at: { type: 'string' },
                      sol_price_usd: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/api/arb-windows': {
        get: {
          operationId: 'get-arb-windows',
          summary: 'Find live arbitrage windows on Solana DEXs',
          description:
            'Quotes triangular SOL→Token→SOL routes via Jupiter lite-api. ' +
            'Computes gross and net profit in basis points after gas and Jito tip. ' +
            'Returns routes above the min_bps threshold.',
          parameters: [
            {
              name: 'capitalSol',
              in: 'query',
              schema: { type: 'number', default: 0.2 },
              description: 'Trade capital in SOL',
            },
            {
              name: 'minBps',
              in: 'query',
              schema: { type: 'number', default: 0 },
              description: 'Minimum net profit in basis points (0 = show all)',
            },
          ],
          responses: {
            '200': {
              description: 'Arb windows found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      windows: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            symbol:      { type: 'string' },
                            mint:        { type: 'string' },
                            gross_bps:   { type: 'number' },
                            net_bps:     { type: 'number' },
                            net_sol:     { type: 'number' },
                            capital_sol: { type: 'number' },
                          },
                        },
                      },
                      profitable_count: { type: 'integer' },
                      scanned_at:       { type: 'string' },
                      sol_price_usd:    { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/api/alpha-signals': {
        get: {
          operationId: 'get-alpha-signals',
          summary: 'Get current alpha signals from on-chain + social sources',
          description:
            'Aggregates signals from DexScreener volume spikes, pump.fun graduations, ' +
            'and momentum data. Returns CONVICTION signals (multi-source agreement) first.',
          parameters: [
            {
              name: 'minScore',
              in: 'query',
              schema: { type: 'integer', default: 40 },
              description: 'Minimum signal score (0-100)',
            },
          ],
          responses: {
            '200': {
              description: 'Alpha signals',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      signals: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            type:    { type: 'string', enum: ['CONVICTION', 'MOMENTUM', 'ACCUMULATION', 'GRADUATION'] },
                            symbol:  { type: 'string' },
                            mint:    { type: 'string' },
                            score:   { type: 'integer' },
                            sources: { type: 'array', items: { type: 'string' } },
                            action:  { type: 'string' },
                          },
                        },
                      },
                      generated_at: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/api/code-audit': {
        post: {
          operationId: 'post-code-audit',
          summary: 'Run automated security audit on Solana program or trading bot code',
          description:
            'Scans TypeScript or Rust code for 13 vulnerability categories: ' +
            'private key exposure, missing signer checks, integer overflow, arbitrary CPI, ' +
            'unbounded retry loops, missing slippage, and more. ' +
            'Returns findings with severity (CRITICAL/HIGH/MEDIUM/LOW) and remediation steps.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'language'],
                  properties: {
                    code:     { type: 'string', description: 'Source code to audit (max 50KB)' },
                    language: { type: 'string', enum: ['typescript', 'rust'] },
                    filename: { type: 'string', description: 'Optional filename for context' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Audit results',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      overall_risk: { type: 'string', enum: ['CLEAN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
                      counts: {
                        type: 'object',
                        properties: {
                          CRITICAL: { type: 'integer' },
                          HIGH:     { type: 'integer' },
                          MEDIUM:   { type: 'integer' },
                          LOW:      { type: 'integer' },
                        },
                      },
                      findings: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id:          { type: 'string' },
                            severity:    { type: 'string' },
                            category:    { type: 'string' },
                            line:        { type: 'integer' },
                            message:     { type: 'string' },
                            remediation: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/api/health': {
        get: {
          operationId: 'health-check',
          summary: 'Agent health and status',
          responses: {
            '200': {
              description: 'Agent is live',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status:    { type: 'string' },
                      version:   { type: 'string' },
                      uptime_ms: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return NextResponse.json(spec, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
