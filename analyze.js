// Gemini analysis (server-side only). Two modes:
//   mode "batch":   analyse one batch of normalized reviews -> validated findings + per-review sentiment
//   mode "summary": write a short summary from already-merged, already-counted findings
// The browser splits the full dataset into batches so every retrieved review is analysed.
const { BATCH_SCHEMA, validateBatchResult, CATEGORIES } = require('../lib/analysis.js');

const MAX_BATCH_REVIEWS = 100;
const MAX_BATCH_CHARS = 60000;
const MAX_FINDINGS = 60;
const GEMINI_TIMEOUT_MS = 22000;
const ATTEMPTS = 2;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}

async function callGemini(prompt, schema, deps) {
  const doFetch = (deps && deps.fetch) || fetch;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 } }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
  });
  if (!r.ok) {
    const err = new Error('gemini_http_' + r.status);
    err.status = r.status;
    try { const b = await r.json(); err.googleStatus = String((b.error && b.error.status) || ''); err.keyProblem = /api key/i.test(String(b.error && b.error.message)); } catch (e) { /* no body */ }
    throw err;
  }
  const payload = await r.json();
  const raw = (payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts || []).map(p => p.text || '').join('');
  return JSON.parse(raw); // throws SyntaxError on invalid JSON -> retried
}

function batchPrompt(reviews, language) {
  return `You are TrustLens, an evidence-grounded review analyst for TikTok Shop shoppers. Write titles and rationales in ${language}.
Analyse ONLY the reviews below. For every recurring or notable point, output a finding with:
- kind: "positive" (praise), "negative" (complaint) or "concern" (something a shopper should check before buying, e.g. product differs from listing, possible safety issue, suspicious repetition). A concern is a signal to verify, never proof of fraud or fake reviews.
- category: one of ${CATEGORIES.join(', ')}
- title: short, specific, neutral (max 12 words)
- rationale: one sentence explaining what the cited reviews say
- review_ids: the exact IDs of EVERY review in this batch that directly supports the finding.
Also output a sentiment label for EVERY review ID: "positive", "neutral" or "negative" (use neutral for mixed or unclear reviews; judge the text, using the star rating only as context).
Never invent reviews, quotes, numbers, seller facts or IDs. Do not compute percentages.
Reviews JSON: ${JSON.stringify(reviews.map(r => ({ id: r.id, rating: r.rating, text: r.text })))}`;
}

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    positives: { type: 'ARRAY', items: { type: 'STRING' } },
    negatives: { type: 'ARRAY', items: { type: 'STRING' } },
    recurring_complaints: { type: 'ARRAY', items: { type: 'STRING' } },
    quality_insights: { type: 'ARRAY', items: { type: 'STRING' } },
    before_buying: { type: 'ARRAY', items: { type: 'STRING' } },
    decision_rationale: { type: 'STRING' }
  },
  required: ['summary', 'positives', 'negatives', 'recurring_complaints', 'quality_insights', 'before_buying', 'decision_rationale']
};

function summaryPrompt(body, language) {
  return `You are TrustLens. Write in ${language}. Below are findings that were already extracted from ${body.analyzed} analysed reviews (out of ${body.retrieved} retrieved). Each has a verified count of supporting reviews.
Write: a 2–4 sentence neutral summary; positives; negatives; recurring_complaints (only findings supported by 2+ reviews); quality_insights; before_buying (practical checks such as return/warranty terms or comparing the listing). Use ONLY these findings and their counts; do not add facts, numbers, percentages, seller details or quotes. If the analysed count is lower than the retrieved count, say the summary covers only the analysed reviews. Never claim reviews are fake or that a seller is fraudulent.
Also write decision_rationale: 2–3 sentences explaining what the evidence below does and does not support for a shopper deciding whether to buy. The evidence stance was computed by TrustLens from counts and is "${body.stance}"; explain it, do not change it. Mention the unknowns. Never tell the user to buy or not buy, never promise quality, never call the seller or reviews fake or fraudulent.
Sentiment counts (Gemini, per review): ${JSON.stringify(body.counts)}. Unknowns: ${JSON.stringify(body.unknowns)}.
Findings JSON: ${JSON.stringify(body.findings)}`;
}

// ---------- mode "report": the structured Vietnamese/English buyer report ----------
// Input: merged findings (with their real supporting review IDs and a few original excerpts).
// Gemini writes headings/explanations and says which findings each theme rests on; the server keeps
// only finding references and review IDs that exist in the input, so every quote shown is a real review.
const MAX_REPORT_FINDINGS = 40, MAX_IDS_PER_FINDING = 60, MAX_EXCERPTS = 3;
const REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    product_category: { type: 'STRING' },
    positives: { type: 'ARRAY', items: { type: 'OBJECT', properties: { heading: { type: 'STRING' }, explanation: { type: 'STRING' }, finding_refs: { type: 'ARRAY', items: { type: 'INTEGER' } }, review_ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['heading', 'explanation', 'finding_refs'] } },
    negatives: { type: 'ARRAY', items: { type: 'OBJECT', properties: { heading: { type: 'STRING' }, explanation: { type: 'STRING' }, impact: { type: 'STRING' }, finding_refs: { type: 'ARRAY', items: { type: 'INTEGER' } }, review_ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['heading', 'explanation', 'finding_refs'] } },
    no_clear_negative: { type: 'BOOLEAN' },
    before_buying: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['product_category', 'positives', 'negatives', 'no_clear_negative', 'before_buying']
};

function cleanReportInput(body) {
  const findings = (Array.isArray(body.findings) ? body.findings : []).slice(0, MAX_REPORT_FINDINGS).map((f, i) => ({
    ref: i,
    kind: ['positive', 'negative', 'concern'].includes(f && f.kind) ? f.kind : null,
    category: String((f && f.category) || '').slice(0, 40),
    title: String((f && f.title) || '').slice(0, 160),
    count: Math.max(0, Number(f && f.count) || 0),
    review_ids: (Array.isArray(f && f.reviewIds) ? f.reviewIds : []).map(String).filter(id => id && id.length <= 100).slice(0, MAX_IDS_PER_FINDING),
    excerpts: (Array.isArray(f && f.excerpts) ? f.excerpts : []).slice(0, MAX_EXCERPTS).map(e => ({ id: String((e && e.reviewId) || '').slice(0, 100), text: String((e && e.text) || '').slice(0, 400) })).filter(e => e.id && e.text)
  })).filter(f => f.kind && f.title && f.review_ids.length);
  return { findings, productName: String(body.productName || '').slice(0, 200), analyzed: Math.max(0, Number(body.analyzed) || 0), retrieved: Math.max(0, Number(body.retrieved) || 0) };
}

function reportPrompt(inp, language) {
  return `You are TrustLens. Write in ${language}. Using ONLY the findings below (each extracted from ${inp.analyzed} analysed customer reviews, with its real supporting review IDs and a few original excerpts), build a buyer report:
- positives: the 3–5 most important positive themes that the findings actually support (fewer if the data supports fewer; none if there are none). For each: a short heading (max 8 words), an explanation of what customers appreciate and why, finding_refs = the "ref" numbers of the positive findings it is based on, review_ids = 1–3 IDs from those findings whose excerpts best illustrate it.
- negatives: the main weaknesses, recurring complaints, limitations or suggestions, from findings of kind "negative" or "concern". For each: heading, explanation, impact (how it may affect the buyer's experience), finding_refs, review_ids (as above). Do not present a point supported by one review as a widespread defect.
- no_clear_negative: true only if there are no negative/concern findings.
- product_category: a short generic category guessed from the review content (e.g. "tai nghe", "áo thun"), or "" if unclear.
- before_buying: 3–5 short practical checks adapted to that category (real buyer photos/videos; size chart only for clothing/footwear; variants, materials, dimensions, compatibility, included accessories when relevant; return/exchange/warranty policy).
Never invent reviews, quotes, statistics, specifications or reviewer identities. Never say reviews are fake or authentic, or that the seller is fraudulent. Product name (may be empty): ${JSON.stringify(inp.productName)}.
Findings JSON: ${JSON.stringify(inp.findings)}`;
}

// Keep only references and IDs that exist in the input; attach TrustLens-computed support counts.
function validateReport(ai, inp) {
  if (!ai || typeof ai !== 'object' || !Array.isArray(ai.positives) || !Array.isArray(ai.negatives)) throw new Error('schema');
  const byRef = new Map(inp.findings.map(f => [f.ref, f]));
  const theme = (x, allowed, max) => (Array.isArray(x) ? x : []).map(t => {
    if (!t || typeof t !== 'object') return null;
    const refs = [...new Set((Array.isArray(t.finding_refs) ? t.finding_refs : []).map(Number))].filter(r => byRef.has(r) && allowed.includes(byRef.get(r).kind));
    if (!refs.length) return null;
    const pool = new Set(refs.flatMap(r => byRef.get(r).review_ids));
    let ids = [...new Set((Array.isArray(t.review_ids) ? t.review_ids : []).map(String))].filter(id => pool.has(id)).slice(0, 3);
    if (!ids.length) ids = [...pool].slice(0, 2);
    const support = refs.reduce((m, r) => Math.max(m, byRef.get(r).count), 0);
    return { heading: String(t.heading || '').trim().slice(0, 120), explanation: String(t.explanation || '').trim().slice(0, 700), impact: t.impact ? String(t.impact).trim().slice(0, 400) : '', finding_refs: refs, review_ids: ids, support, supportIds: [...pool] };
  }).filter(t => t && t.heading && t.explanation).slice(0, max);
  const negatives = theme(ai.negatives, ['negative', 'concern'], 6);
  return {
    product_category: String(ai.product_category || '').slice(0, 60),
    positives: theme(ai.positives, ['positive'], 5),
    negatives,
    no_clear_negative: !inp.findings.some(f => f.kind !== 'positive') || (ai.no_clear_negative === true && !negatives.length),
    before_buying: (Array.isArray(ai.before_buying) ? ai.before_buying : []).map(x => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 6)
  };
}

async function withRetries(fn) {
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e && (e.status === 400 || e.status === 401 || e.status === 403)) break; // not retryable
    }
  }
  throw lastErr;
}

// Map Gemini failures to safe, specific codes. Only the HTTP status and Google's status enum are
// returned (never the key or the upstream message), so the site owner can see what to fix.
function aiErrorResponse(res, e) {
  const status = e && e.status;
  const upstream = status ? { http: status, status: /^[A-Z_]{1,40}$/.test(e.googleStatus || '') ? e.googleStatus : null } : undefined;
  if (status === 429) return send(res, 429, { error: 'ai_rate_limited', message: 'AI provider rate limit or quota reached.', upstream });
  if (status === 401 || status === 403 || (status === 400 && e.keyProblem)) return send(res, 502, { error: 'ai_auth', message: 'AI provider rejected the server API key.', upstream });
  if (status === 404) return send(res, 502, { error: 'ai_model_unavailable', message: 'The configured Gemini model is not available to this key.', upstream });
  if (status) return send(res, 502, { error: 'ai_failed', message: 'AI analysis failed.', upstream });
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return send(res, 504, { error: 'ai_timeout', message: 'AI provider timed out.' });
  if (e && (e instanceof SyntaxError || e.message === 'schema')) return send(res, 502, { error: 'ai_invalid_output', message: 'AI returned invalid structured output after retries.' });
  return send(res, 502, { error: 'ai_failed', message: 'AI analysis failed.' });
}

async function handler(req, res, deps) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: 'ai_not_configured', message: 'AI analysis is not configured on the server (GEMINI_API_KEY).' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const language = body.language === 'vi' ? 'Vietnamese' : 'English';

  if (body.mode === 'report') {
    const inp = cleanReportInput(body);
    if (!inp.findings.length) return send(res, 400, { error: 'no_findings', message: 'No findings with supporting reviews to report on.' });
    try {
      const report = await withRetries(async () => validateReport(await callGemini(reportPrompt(inp, language), REPORT_SCHEMA, deps), inp));
      return send(res, 200, { ok: true, report });
    } catch (e) { return aiErrorResponse(res, e); }
  }

  if (body.mode === 'summary') {
    const findings = Array.isArray(body.findings) ? body.findings.slice(0, MAX_FINDINGS).map(f => ({ kind: String(f.kind || '').slice(0, 20), category: String(f.category || '').slice(0, 40), title: String(f.title || '').slice(0, 160), count: Number(f.count) || 0 })) : [];
    const analyzed = Number(body.analyzed) || 0, retrieved = Number(body.retrieved) || 0;
    const STANCES = ['insufficient_evidence', 'mostly_positive', 'mixed', 'mostly_negative'];
    const stance = STANCES.includes(body.stance) ? body.stance : 'insufficient_evidence';
    const counts = {}; for (const k of ['positive', 'neutral', 'negative']) counts[k] = Math.max(0, Number(body.counts && body.counts[k]) || 0);
    const unknowns = Array.isArray(body.unknowns) ? body.unknowns.map(String).filter(u => /^[a-z_]{1,30}$/.test(u)).slice(0, 8) : [];
    if (!findings.length && !(counts.positive + counts.neutral + counts.negative)) return send(res, 400, { error: 'no_findings', message: 'Nothing to summarise.' });
    try {
      const out = await withRetries(async () => {
        const ai = await callGemini(summaryPrompt({ findings, analyzed, retrieved, stance, counts, unknowns }, language), SUMMARY_SCHEMA, deps);
        if (!ai || typeof ai.summary !== 'string' || !ai.summary.trim()) throw new Error('schema');
        const list = k => (Array.isArray(ai[k]) ? ai[k] : []).map(s => String(s).slice(0, 300)).slice(0, 8);
        return { summary: ai.summary.slice(0, 1500), positives: list('positives'), negatives: list('negatives'), recurring_complaints: list('recurring_complaints'), quality_insights: list('quality_insights'), before_buying: list('before_buying'), decision_rationale: String(ai.decision_rationale || '').slice(0, 1200) };
      });
      return send(res, 200, { ok: true, summary: out });
    } catch (e) { return aiErrorResponse(res, e); }
  }

  // Default: batch mode
  const input = Array.isArray(body.reviews) ? body.reviews : [];
  if (!input.length) return send(res, 400, { error: 'no_reviews', message: 'Provide at least one review.' });
  if (input.length > MAX_BATCH_REVIEWS) return send(res, 413, { error: 'batch_too_large', message: `Send at most ${MAX_BATCH_REVIEWS} reviews per batch.` });
  const reviews = input.map(r => ({ id: String((r && r.id) || '').slice(0, 100), text: String((r && r.text) || '').slice(0, 2000), rating: r && r.rating != null ? Number(r.rating) || null : null })).filter(r => r.id && r.text.trim());
  if (!reviews.length) return send(res, 400, { error: 'no_reviews', message: 'No usable review text.' });
  if (reviews.reduce((s, r) => s + r.text.length, 0) > MAX_BATCH_CHARS) return send(res, 413, { error: 'batch_too_large', message: 'Batch text too long.' });
  const ids = reviews.map(r => r.id);
  try {
    const result = await withRetries(async () => validateBatchResult(await callGemini(batchPrompt(reviews, language), BATCH_SCHEMA, deps), ids));
    return send(res, 200, { ok: true, analyzedIds: ids, ...result });
  } catch (e) { return aiErrorResponse(res, e); }
}

module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
