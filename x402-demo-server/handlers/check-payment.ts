import type { Context } from 'hono';
import Groq from 'groq-sdk';
import { parseAIResponse, RISK_ANALYSIS_SYSTEM_PROMPT, MAX_CONTENT_LENGTH } from './ai-analysis.js';

// Algorand TestNet public indexer — no API key required
const INDEXER_URL = 'https://testnet-idx.algonode.cloud';
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
 * Query the Algorand TestNet indexer for a confirmed USDC payment.
 * Returns the transaction ID if found, or null.
 */
async function findUSDCPaymentOnChain(
  receiver: string,
  minAmountMicro: number,
  afterEpochSeconds: number,
): Promise<string | null> {
  const afterISO = new Date(afterEpochSeconds * 1000).toISOString();

  const url =
    `${INDEXER_URL}/v2/transactions` +
    `?address=${encodeURIComponent(receiver)}` +
    `&address-role=receiver` +
    `&asset-id=${USDC_ASSET_ID}` +
    `&min-amount=${minAmountMicro}` +
    `&after-time=${encodeURIComponent(afterISO)}` +
    `&limit=20`;

  console.log(`[PAYMENT] Querying Algorand indexer: min=${minAmountMicro} µUSDC after=${afterISO}`);

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });

    if (!resp.ok) {
      console.warn(`[PAYMENT] Indexer returned HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { transactions?: IndexerTx[] };
    const txns = data.transactions ?? [];
    console.log(`[PAYMENT] Indexer returned ${txns.length} transaction(s)`);

    for (const tx of txns) {
      const axfer = tx['asset-transfer-transaction'];
      if (!axfer) continue;
      if (axfer['asset-id'] !== USDC_ASSET_ID) continue;
      if (axfer.receiver.toUpperCase() !== receiver.toUpperCase()) continue;
      if (axfer.amount < minAmountMicro) continue;

      const roundTime = tx['round-time'] ?? 0;
      if (roundTime < afterEpochSeconds - 60) continue; // 60s slack for clock skew

      console.log(`[PAYMENT] ✅ Payment verified on-chain! txID=${tx.id} amount=${axfer.amount}µUSDC`);
      return tx.id;
    }

    console.log('[PAYMENT] No qualifying payment found yet');
    return null;
  } catch (err) {
    console.warn('[PAYMENT] Indexer query error:', (err as Error).message);
    return null;
  }
}

/**
 * Validate a specific txId on-chain — confirms it is a real USDC payment
 * to the receiver. Used to prevent clients from re-using a txId from a
 * different session or fabricating a transaction ID.
 */
async function validateTxIdOnChain(
  txId: string,
  receiver: string,
  minAmountMicro: number,
): Promise<boolean> {
  const url = `${INDEXER_URL}/v2/transactions/${encodeURIComponent(txId)}`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { transaction?: IndexerTx };
    const tx = data.transaction;
    if (!tx) return false;
    const axfer = tx['asset-transfer-transaction'];
    if (!axfer) return false;
    if (axfer['asset-id'] !== USDC_ASSET_ID) return false;
    if (axfer.receiver.toUpperCase() !== receiver.toUpperCase()) return false;
    if (axfer.amount < minAmountMicro) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /check-payment
 *
 * Polls the Algorand TestNet indexer to verify USDC payment on-chain.
 * ONLY runs AI analysis after payment is confirmed.
 *
 * Request body:
 *   { content: string, startedAt: number (ms), amount: number (µUSDC) }
 *   OR for AI-retry after payment already confirmed:
 *   { content: string, txId: string }   ← skip indexer, run AI directly
 *
 * Responses:
 *   { paid: false }                           — payment not yet confirmed
 *   { paid: true, results: {...}, ... }       — payment confirmed + AI done
 *   HTTP 400                                  — bad request
 *   HTTP 502                                  — AI failed after confirmed payment
 *   HTTP 503                                  — server misconfigured
 */
export async function handleCheckPayment(c: Context): Promise<Response> {
  const receiver = process.env.AVM_ADDRESS;
  if (!receiver) {
    console.error('[PAYMENT] AVM_ADDRESS not configured');
    return c.json({ error: 'Server misconfigured: AVM_ADDRESS not set' }, 503);
  }

  let content: string;
  let startedAt: number;
  let amountMicro: number;
  let retryTxId: string | null = null;

  try {
    const body = await c.req.json();
    content   = String(body?.content ?? '').trim();
    startedAt = Number(body?.startedAt) || (Date.now() - 600_000);
    amountMicro = Number(body?.amount) || 10000;
    retryTxId = body?.txId ? String(body.txId).trim() : null;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!content) {
    return c.json({ error: '"content" is required' }, 400);
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: 'Content too long' }, 400);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.error('[AI] GROQ_API_KEY not configured');
    return c.json({ error: 'AI service not configured. Set GROQ_API_KEY in .env.' }, 503);
  }

  let txId: string;

  // ── Path A: retry after already-confirmed payment (txId provided) ─────────
  if (retryTxId) {
    // Validate the txId exists on-chain before trusting it
    console.log(`[PAYMENT] Retry with existing txID=${retryTxId} — validating on-chain...`);
    const verified = await validateTxIdOnChain(retryTxId, receiver, amountMicro);
    if (!verified) {
      console.warn(`[PAYMENT] txID=${retryTxId} not found or invalid — rejecting retry`);
      return c.json({ paid: false, error: 'Transaction ID could not be verified.' });
    }
    txId = retryTxId;
    console.log(`[PAYMENT] txID=${txId} re-validated ✅ — running AI analysis`);
  } else {
    // ── Path B: fresh check — query the Algorand indexer ─────────────────────
    console.log(`[PAYMENT] Payment verification started for content (${content.length} chars)`);
    console.log(`[PAYMENT] Waiting for payment — receiver=${receiver} amount=${amountMicro}µUSDC`);

    // Allow 60s of slack on the lookback window
    const lookbackSeconds = Math.floor((startedAt - 60_000) / 1000);
    const found = await findUSDCPaymentOnChain(receiver, amountMicro, lookbackSeconds);

    if (!found) {
      return c.json({ paid: false, checked_at: new Date().toISOString() });
    }
    txId = found;
    console.log(`[PAYMENT] Payment verified successfully. txID=${txId}`);
  }

  // ── Run AI analysis (only reached after payment verification) ─────────────
  console.log('[AI] Starting risk analysis...');

  const groq = new Groq({ apiKey: groqKey });

  try {
    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.8-27b',
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
    console.log(`[AI] Risk analysis completed. Level=${analysis.risk_level} Score=${analysis.risk_score}/100`);

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
    console.error('[AI] Risk analysis failed after payment verification:', err);
    // Payment was real — return the txId so the frontend can retry AI only
    return c.json({
      paid: true,
      transaction_id: txId,
      error: 'Payment verified, but AI analysis failed. Please try again.',
    }, 502);
  }
}
