import { config } from 'dotenv';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { USDC_TESTNET_ASA_ID } from '@x402/avm';
import { handleAIAnalysisRequest } from './handlers/ai-analysis.js';
import { handleCheckPayment } from './handlers/check-payment.js';

// Full Algorand TestNet CAIP-2 as used by GoPlausible facilitator
// @x402/avm exports a truncated constant, so we define the full value here
const AVM_NETWORK = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as Network;

config();

// ─── Environment Validation ─────────────────────────────────────────────────

const avmAddress = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;
const port = parseInt(process.env.PORT ?? '4021', 10);

if (!avmAddress) {
  console.error('[Server] FATAL: AVM_ADDRESS environment variable is required');
  process.exit(1);
}
if (!facilitatorUrl) {
  console.error('[Server] FATAL: FACILITATOR_URL environment variable is required');
  process.exit(1);
}

console.log('[Server] Configuration:');
console.log(`  AVM_ADDRESS     : ${avmAddress}`);
console.log(`  FACILITATOR_URL : ${facilitatorUrl}`);
console.log(`  PORT            : ${port}`);
console.log(`  OPENAI_API_KEY  : ${process.env.OPENAI_API_KEY ? '[SET]' : '[NOT SET - REQUIRED]'}`);

// ─── x402 Resource Server Setup ─────────────────────────────────────────────

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);

const avmServerScheme = new ExactAvmScheme();
server.register(AVM_NETWORK, avmServerScheme);

console.log('[Server] x402 resource server initialized');
console.log(`[Server] Registered network: ${AVM_NETWORK}`);

// ─── Payment Middleware Config ───────────────────────────────────────────────

const paymentConfig = {
  'POST /ai-analysis': {
    accepts: [
      {
        scheme: 'exact' as const,
        price: '$0.01',
        network: AVM_NETWORK,
        payTo: avmAddress,
        extra: { asset: USDC_TESTNET_ASA_ID },
      },
    ],
    description: 'AI-powered cybersecurity risk analysis of text content',
    mimeType: 'application/json',
  },
};

// ─── Hono App ────────────────────────────────────────────────────────────────

const app = new Hono();

// 1. CORS — MUST be first, before everything else
app.use('*', async (c, next) => {
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };

  // Handle browser preflight immediately
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Attach CORS headers to all responses
  Object.entries(corsHeaders).forEach(([key, value]) => {
    c.header(key, value);
  });

  await next();
});

// 2. Request logging
app.use('*', async (c, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`);
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

// ─── Public Routes ───────────────────────────────────────────────────────────

app.get('/health', c => {
  return c.json({
    status: 'ok',
    service: 'RiskGuard AI — x402 Risk Analysis Server',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

app.get('/info', c => {
  return c.json({
    service: 'RiskGuard AI',
    description: 'AI-powered cybersecurity risk analysis with x402 pay-per-use payments',
    version: '1.0.0',
    endpoints: {
      'GET /health': { public: true, description: 'Health check' },
      'GET /info': { public: true, description: 'Service information' },
      'POST /ai-analysis': {
        public: false,
        payment_required: true,
        price: '$0.01 USDC',
        network: 'Algorand TestNet',
        description: 'Analyze text content for cybersecurity risks using AI',
      },
      'POST /check-payment': {
        public: true,
        description: 'Check if on-chain USDC payment arrived; if yes, run AI analysis automatically',
      },
      'POST /analyze-direct': {
        public: true,
        description: 'Run AI analysis directly without payment gate (used after manual payment confirmation)',
      },
    },
    payment: {
      facilitator: facilitatorUrl,
      receiver: avmAddress,
      network: AVM_NETWORK,
      asset: USDC_TESTNET_ASA_ID,
    },
    timestamp: new Date().toISOString(),
  });
});

// Public payment-check endpoint — polls Algorand indexer directly, no payment-signature needed
app.post('/check-payment', handleCheckPayment);

// Direct analysis endpoint — runs OpenAI without payment gate
// Used when user manually confirms payment via "I Have Paid" button
app.post('/analyze-direct', handleAIAnalysisRequest);

// ─── Payment Middleware (only protects configured routes) ───────────────────

// syncFacilitatorOnStart defaults to true — will call facilitator /supported on startup
app.use(paymentMiddleware(paymentConfig, server));

// ─── Protected Routes ────────────────────────────────────────────────────────

app.post('/ai-analysis', handleAIAnalysisRequest);

// ─── 404 Handler ────────────────────────────────────────────────────────────

app.notFound(c => {
  return c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404);
});

// ─── Error Handler ───────────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('[Server] Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ─── Start Server ────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port }, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          RiskGuard AI — x402 Resource Server         ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Listening on: http://localhost:${port}                  ║`);
  console.log('║  Public:  GET  /health                               ║');
  console.log('║  Public:  GET  /info                                 ║');
  console.log('║  Public:  POST /check-payment  (blockchain poll)     ║');
  console.log('║  Paid:    POST /ai-analysis    ($0.01 USDC)          ║');
  console.log('║  Network: Algorand TestNet                           ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
