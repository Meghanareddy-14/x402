import type { Context } from 'hono';
import OpenAI from 'openai';
import { parseAIResponse, RISK_ANALYSIS_SYSTEM_PROMPT, MAX_CONTENT_LENGTH } from './ai-analysis.js';

// Algorand TestNet public indexer — no API key required
const INDEXER_URL = 'https://testnet-idx.algonode.cloud';
// USDC ASA ID on Algorand TestNet
const USDC_ASSET_ID = 10458941;

interface IndexerTx {
  id: string;
  'asset-transfer-transaction'?: {
    'asset-id': number;
    receiver: string;
    amount: number;
  };
  'round-time'?: number;
}

/**
 * Query the Algorand TestNet indexer for a USDC payment to the receiver.
 * Returns the on-chain transaction ID if a qualifying payment is found, or null.
 */
async function findUSDCPaymentOnChain(
  receiver: string,
  minAmountMicro: number,
  afterEpochSeconds: number,
): Promise<string | null> {
  // afterTime must be ISO8601 — the indexer accepts it directly
  const afterISO = new Date(afterEpochSeconds * 1000).toISOString();

  const url =
    `${INDEXER_URL}/v2/transactions` +
    `?address=${encodeURIComponent(receiver)}` +
    `&address-role=receiver` +
    `&asset-id=${USDC_ASSET_ID}` +
    `&min-amount=${minAmountMicro}` +
    `&after-time=${encodeURIComponent(afterISO)}` +
    `&limit=20`;

  console.log(`[CheckPayment] Querying indexer: min=${minAmountMicro} µUSDC after=${afterISO}`);

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`[CheckPayment] Indexer HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { transactions?: IndexerTx[] };
    const txns = data.transactions ?? [];
    console.log(`[CheckPayment] Indexer returned ${txns.length} transaction(s)`);

    for (const tx of txns) {
      const axfer = tx['asset-transfer-transaction'];
      if (!axfer) continue;
      if (axfer['asset-id'] !== USDC_ASSET_ID) continue;
      // Normalize both addresses to uppercase for comparison
      if (axfer.receiver.toUpperCase() !== receiver.toUpperCase()) continue;
      if (axfer.amount < minAmountMicro) continue;

      const roundTime = tx['round-time'] ?? 0;
      if (roundTime < afterEpochSeconds - 30) continue; // allow 30s slack

      console.log(`[CheckPayment] ✅ Payment found! txID=${tx.id} amount=${axfer.amount}µUSDC round-time=${roundTime}`);
      return tx.id;
    }

    console.log('[CheckPayment] No qualifying payment found yet');
    return null;
  } catch (err) {
    console.warn('[CheckPayment] Indexer query error:', (err as Error).message);
    return null;
  }
}

/**
 * POST /check-payment
 *
 * Public endpoint — no payment-signature header required.
 * Polls the Algorand TestNet indexer to see if USDC payment has arrived.
 * If payment is confirmed on-chain, runs AI analysis and returns result.
 * If not yet paid, returns { paid: false }.
 *
 * Request body:
 *   { content: string, startedAt: number (ms), amount: number (micro-USDC) }
 *
 * Response on payment found:
 *   { paid: true, transaction_id: string, results: {...}, ... }
 *
 * Response when not yet paid:
 *   { paid: false, checked_at: string }
 */
export async function handleCheckPayment(c: Context): Promise<Response> {
  const receiver = process.env.AVM_ADDRESS;
  if (!receiver) {
    return c.json({ error: 'Server misconfigured: AVM_ADDRESS not set' }, 503);
  }

  let content: string;
  let startedAt: number;
  let amountMicro: number;

  try {
    const body = await c.req.json();
    content = String(body?.content ?? '').trim();
    startedAt = Number(body?.startedAt) || (Date.now() - 300_000);
    amountMicro = Number(body?.amount) || 10000; // default $0.01 USDC
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!content) {
    return c.json({ error: '"content" is required' }, 400);
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: 'Content too long' }, 400);
  }

  // Look back from 30 seconds before the session started (handles clock skew)
  const lookbackSeconds = Math.floor((startedAt - 30_000) / 1000);

  const txId = await findUSDCPaymentOnChain(receiver, amountMicro, lookbackSeconds);

  if (!txId) {
    return c.json({ paid: false, checked_at: new Date().toISOString() });
  }

  // ── Payment confirmed — run AI analysis ─────────────────────────────────

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey === 'your_openai_api_key_here') {
    return c.json({ error: 'AI service not configured' }, 503);
  }

  const openai = new OpenAI({ apiKey: openaiKey });

  try {
    console.log(`[CheckPayment] Running AI analysis for content (${content.length} chars)...`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: RISK_ANALYSIS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze the following text for cybersecurity risks:\n\n---\n${content}\n---`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });

    const rawContent = completion.choices[0]?.message?.content;
    if (!rawContent) throw new Error('Empty AI response');

    const analysis = parseAIResponse(rawContent);

    console.log(`[CheckPayment] Analysis complete: ${analysis.risk_level} (${analysis.risk_score}/100)`);

    return c.json({
      paid: true,
      transaction_id: txId,
      input_length: content.length,
      analysis_type: 'risk',
      results: analysis,
      model: completion.model,
      usage: completion.usage
        ? {
            prompt_tokens: completion.usage.prompt_tokens,
            completion_tokens: completion.usage.completion_tokens,
            total_tokens: completion.usage.total_tokens,
          }
        : {},
      paid_via_x402: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CheckPayment] AI analysis failed:', err);
    return c.json({ error: 'AI analysis failed. Payment was confirmed — please try again.' }, 502);
  }
}
