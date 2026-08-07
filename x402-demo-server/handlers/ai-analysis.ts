import type { Context } from 'hono';
import OpenAI from 'openai';

export const MAX_CONTENT_LENGTH = 5000;

export const RISK_ANALYSIS_SYSTEM_PROMPT = `You are an expert cybersecurity analyst specializing in threat detection and risk assessment.

Your task is to analyze the provided text for security and risk indicators. You must evaluate:
1. Phishing indicators
2. Scam indicators
3. Credential harvesting attempts
4. Malware indicators
5. Suspicious URLs or links
6. Social engineering techniques
7. Urgency manipulation tactics
8. Financial fraud indicators
9. Impersonation of trusted entities
10. Requests for passwords, PINs, or OTP/security codes
11. Suspicious attachment references
12. Threats or coercion
13. Data exfiltration attempts
14. Brand spoofing or lookalike domain references
15. Any other cybersecurity risks

Classify the overall risk as one of: LOW, MEDIUM, HIGH, CRITICAL

Risk level guidelines:
- LOW: Benign content with no significant security indicators
- MEDIUM: Contains some suspicious elements but may be legitimate; warrants caution
- HIGH: Multiple strong indicators of malicious intent; likely a threat
- CRITICAL: Extremely dangerous content with clear, immediate threat; multiple critical attack vectors

You MUST respond with ONLY valid JSON in exactly this format (no markdown, no explanation, just the JSON object):
{
  "risk_level": "HIGH",
  "risk_score": 87,
  "summary": "Brief summary of the analysis in 1-2 sentences.",
  "threats": [
    {
      "type": "Phishing",
      "severity": "HIGH",
      "evidence": "Specific evidence from the text that supports this threat classification."
    }
  ],
  "indicators": [
    "Urgency manipulation",
    "Suspicious URL",
    "Credential request"
  ],
  "recommendations": [
    "Do not click any links in this message.",
    "Do not provide any personal information.",
    "Report this message to your security team."
  ]
}

Rules:
- risk_score must be an integer 0-100 (0=completely safe, 100=maximum danger)
- threats array may be empty for LOW risk content
- indicators array should list specific red flags found
- recommendations must be actionable
- All text fields must be plain strings with no HTML or special formatting
- Respond ONLY with the JSON object, nothing else`;

interface ThreatDetail {
  type: string;
  severity: string;
  evidence: string;
}

interface RiskAnalysis {
  risk_level: string;
  risk_score: number;
  summary: string;
  threats: ThreatDetail[];
  indicators: string[];
  recommendations: string[];
}

function validateRiskAnalysis(data: unknown): RiskAnalysis {
  if (!data || typeof data !== 'object') {
    throw new Error('AI response is not a valid object');
  }

  const obj = data as Record<string, unknown>;

  const validLevels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!obj.risk_level || !validLevels.includes(String(obj.risk_level))) {
    throw new Error(`Invalid risk_level: ${obj.risk_level}`);
  }

  const score = Number(obj.risk_score);
  if (isNaN(score) || score < 0 || score > 100) {
    throw new Error(`Invalid risk_score: ${obj.risk_score}`);
  }

  if (!obj.summary || typeof obj.summary !== 'string') {
    throw new Error('Missing or invalid summary');
  }

  if (!Array.isArray(obj.threats)) {
    throw new Error('threats must be an array');
  }

  if (!Array.isArray(obj.indicators)) {
    throw new Error('indicators must be an array');
  }

  if (!Array.isArray(obj.recommendations)) {
    throw new Error('recommendations must be an array');
  }

  return {
    risk_level: String(obj.risk_level),
    risk_score: Math.round(score),
    summary: String(obj.summary),
    threats: obj.threats.map((t: unknown) => {
      if (!t || typeof t !== 'object') return { type: 'Unknown', severity: 'MEDIUM', evidence: '' };
      const threat = t as Record<string, unknown>;
      return {
        type: String(threat.type || 'Unknown'),
        severity: String(threat.severity || 'MEDIUM'),
        evidence: String(threat.evidence || ''),
      };
    }),
    indicators: obj.indicators.map((i: unknown) => String(i)),
    recommendations: obj.recommendations.map((r: unknown) => String(r)),
  };
}

export function parseAIResponse(rawContent: string): RiskAnalysis {
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(rawContent.trim());
    return validateRiskAnalysis(parsed);
  } catch {
    // Try to extract JSON from response (in case model added text around it)
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return validateRiskAnalysis(parsed);
      } catch (err2) {
        throw new Error(`Failed to parse AI response JSON: ${err2}`);
      }
    }
    throw new Error('No valid JSON found in AI response');
  }
}

export async function handleAIAnalysisRequest(c: Context): Promise<Response> {
  let content: string;

  try {
    const body = await c.req.json();
    content = body?.content;
  } catch {
    return c.json({ error: 'Invalid request body. Expected JSON with "content" field.' }, 400);
  }

  if (!content || typeof content !== 'string') {
    return c.json({ error: 'Missing required field: "content" must be a non-empty string.' }, 400);
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return c.json({ error: 'Content cannot be empty.' }, 400);
  }

  if (trimmed.length > MAX_CONTENT_LENGTH) {
    return c.json(
      { error: `Content too long. Maximum allowed: ${MAX_CONTENT_LENGTH} characters.` },
      400,
    );
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey === 'your_openai_api_key_here') {
    console.error('[AI Analysis] OPENAI_API_KEY is not configured');
    return c.json({ error: 'AI analysis service is not configured. Please set OPENAI_API_KEY.' }, 503);
  }

  const openai = new OpenAI({ apiKey: openaiKey });

  let analysis: RiskAnalysis;
  let modelUsed: string;
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};

  try {
    console.log(`[AI Analysis] Analyzing content (${trimmed.length} chars)...`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: RISK_ANALYSIS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze the following text for cybersecurity risks:\n\n---\n${trimmed}\n---`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });

    modelUsed = completion.model;
    if (completion.usage) {
      usage = {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
      };
    }

    const rawContent = completion.choices[0]?.message?.content;
    if (!rawContent) {
      throw new Error('OpenAI returned an empty response');
    }

    console.log('[AI Analysis] Raw AI response received, parsing...');
    analysis = parseAIResponse(rawContent);
    console.log(`[AI Analysis] Analysis complete. Risk level: ${analysis.risk_level} (${analysis.risk_score}/100)`);
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      console.error(`[AI Analysis] OpenAI API error: ${err.status} ${err.message}`);

      if (err.status === 401) {
        return c.json({ error: 'AI service authentication failed. Please check OPENAI_API_KEY.' }, 503);
      }
      if (err.status === 429) {
        return c.json({ error: 'AI service rate limit reached. Please try again shortly.' }, 503);
      }
      if (err.status === 500 || err.status === 503) {
        return c.json({ error: 'AI service temporarily unavailable. Please try again later.' }, 503);
      }
      return c.json({ error: `AI service error: ${err.message}` }, 503);
    }

    if (err instanceof Error && err.message.includes('parse')) {
      console.error(`[AI Analysis] Response parse error: ${err.message}`);
      return c.json({ error: 'AI returned an invalid response format. Please try again.' }, 502);
    }

    console.error('[AI Analysis] Unexpected error:', err);
    return c.json({ error: 'An unexpected error occurred during analysis.' }, 500);
  }

  return c.json({
    input_length: trimmed.length,
    analysis_type: 'risk',
    results: analysis,
    model: modelUsed,
    usage,
    paid_via_x402: true,
    timestamp: new Date().toISOString(),
  });
}
