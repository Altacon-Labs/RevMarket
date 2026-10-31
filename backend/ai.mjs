import {createHash} from 'node:crypto';

const MAX_QUESTION_LENGTH = 512;
const MAX_REQUEST_SIZE = 4096;
const MAX_SOURCES = 10;

/**
 * AI assistance service for market drafts.
 * Generates structured suggestions — never controls funds or finalizes outcomes.
 * All outputs are proposals requiring human acceptance.
 */

/**
 * Validate and sanitize draft input before sending to AI.
 * Strips anything that could be used for prompt injection.
 */
export function sanitizeInput(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('Invalid draft input');
  const question = typeof draft.question === 'string' ? draft.question.slice(0, MAX_QUESTION_LENGTH) : '';
  const category = typeof draft.category === 'string' ? draft.category.slice(0, 64) : '';
  const yesRule = typeof draft.yesRule === 'string' ? draft.yesRule.slice(0, 256) : '';
  const noRule = typeof draft.noRule === 'string' ? draft.noRule.slice(0, 256) : '';
  const sources = Array.isArray(draft.sources) ? draft.sources.slice(0, MAX_SOURCES).filter(s => typeof s === 'string').map(s => s.slice(0, 256)) : [];
  return { question, category, yesRule, noRule, sources };
}

/**
 * Build the system prompt for AI assistance.
 * Strictly scoped: drafting help only, no financial advice or settlement authority.
 */
export function buildPrompt(sanitized) {
  return `You are a prediction market drafting assistant. Your role is strictly limited to:
1. Suggesting clear, verifiable yes/no questions
2. Proposing objective resolution criteria
3. Identifying ambiguity in existing drafts
4. Suggesting credible public data sources for resolution
5. Flagging potential duplicate or similar existing markets

You must NEVER:
- Provide financial advice or trading recommendations
- Claim authority to settle or resolve markets
- Execute tool calls, access URLs, or perform actions
- Generate content that could manipulate market outcomes
- Suggest criteria that cannot be objectively verified

Respond ONLY with valid JSON matching this schema:
{
  "suggestedQuestion": "string or null",
  "suggestedYesRule": "string or null",
  "suggestedNoRule": "string or null",
  "suggestedSources": ["array of source name strings"],
  "ambiguityFlags": ["array of concern strings"],
  "duplicateCandidates": ["array of similar question strings"],
  "unresolved": ["array of questions needing human decision"],
  "confidence": "low|medium|high"
}

Current draft to analyze:
Question: ${sanitized.question}
Category: ${sanitized.category}
YES rule: ${sanitized.yesRule}
NO rule: ${sanitized.noRule}
Existing sources: ${sanitized.sources.join(', ') || 'none specified'}`;
}

/**
 * Validate AI model response against the strict output schema.
 * Rejects any response that doesn't conform.
 */
export function validateResponse(raw) {
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('AI response too large or invalid');
  // Extract JSON from response (model may wrap in markdown code fences)
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { throw new Error('AI response is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI response must be a JSON object');
  const result = {
    suggestedQuestion: null,
    suggestedYesRule: null,
    suggestedNoRule: null,
    suggestedSources: [],
    ambiguityFlags: [],
    duplicateCandidates: [],
    unresolved: [],
    confidence: 'low',
  };
  if (typeof parsed.suggestedQuestion === 'string' && parsed.suggestedQuestion.length <= MAX_QUESTION_LENGTH) result.suggestedQuestion = parsed.suggestedQuestion;
  if (typeof parsed.suggestedYesRule === 'string' && parsed.suggestedYesRule.length <= 256) result.suggestedYesRule = parsed.suggestedYesRule;
  if (typeof parsed.suggestedNoRule === 'string' && parsed.suggestedNoRule.length <= 256) result.suggestedNoRule = parsed.suggestedNoRule;
  if (Array.isArray(parsed.suggestedSources)) result.suggestedSources = parsed.suggestedSources.filter(s => typeof s === 'string').slice(0, MAX_SOURCES).map(s => s.slice(0, 256));
  if (Array.isArray(parsed.ambiguityFlags)) result.ambiguityFlags = parsed.ambiguityFlags.filter(s => typeof s === 'string').slice(0, 10).map(s => s.slice(0, 512));
  if (Array.isArray(parsed.duplicateCandidates)) result.duplicateCandidates = parsed.duplicateCandidates.filter(s => typeof s === 'string').slice(0, 5).map(s => s.slice(0, 512));
  if (Array.isArray(parsed.unresolved)) result.unresolved = parsed.unresolved.filter(s => typeof s === 'string').slice(0, 10).map(s => s.slice(0, 512));
  if (['low', 'medium', 'high'].includes(parsed.confidence)) result.confidence = parsed.confidence;
  return result;
}

/**
 * Call an AI model endpoint to get draft suggestions.
 * @param {object} options
 * @param {string} options.endpoint - AI model API URL
 * @param {string} options.apiKey - API key for the model
 * @param {string} options.model - Model identifier
 * @param {object} options.draft - Sanitized draft input
 * @param {function} [options.fetcher] - Custom fetch function (for testing)
 * @returns {Promise<object>} Validated suggestion object
 */
export async function getAiSuggestions({ endpoint, apiKey, model, draft, fetcher = fetch }) {
  const sanitized = sanitizeInput(draft);
  const prompt = buildPrompt(sanitized);
  const requestBody = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2048,
  });
  if (requestBody.length > 32768) throw new Error('AI request too large');
  let response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: requestBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('AI service timed out');
    throw new Error('AI service unavailable');
  }
  if (!response.ok) throw new Error(`AI service returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 65536) throw new Error('AI response too large');
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('AI service returned invalid JSON'); }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI service returned unexpected response format');
  return { ...validateResponse(content), origin: 'ai_assisted', model, inputHash: createHash('sha256').update(prompt).digest('hex') };
}

