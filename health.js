// Safe deployment health check. Reports configuration presence only; never returns secret values.
// GET /api/health?check=ai additionally verifies that the Gemini key can actually generate with the
// configured model (a 1-token request; a model lookup alone can succeed for models the key may not use).
// Only status codes are returned.
async function checkGemini(env, doFetch) {
  if (!env.GEMINI_API_KEY) return { ok: false, reason: 'not_configured' };
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  try {
    const r = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }),
      signal: AbortSignal.timeout(10000)
    });
    let status = null; if (!r.ok) { try { const b = await r.json(); status = /^[A-Z_]{1,40}$/.test(String(b.error && b.error.status)) ? b.error.status : null; } catch (e) { /* ignore */ } }
    return { ok: r.ok, model, http: r.status, status };
  } catch (e) { return { ok: false, model, reason: 'unreachable' }; }
}

async function handler(req, res, deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const providers = {
    gemini: Boolean(env.GEMINI_API_KEY),
    socialfetch: Boolean(env.SOCIALFETCH_API_KEY),
    socq: Boolean(env.SOCQ_API_KEY)
  };
  const wantAi = req.query ? req.query.check === 'ai' : /[?&]check=ai\b/.test(req.url || '');
  const aiCheck = wantAi ? await checkGemini(env, deps.fetch || fetch) : undefined;
  return res.status(200).json({
    ok: true,
    service: 'TrustLens',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    providers,
    reviewProviderReady: providers.socialfetch || providers.socq,
    reviewRegion: env.REVIEW_REGION || 'VN',
    aiReady: providers.gemini,
    maxPages: Number(env.REVIEW_MAX_PAGES) || 20,
    aiCheck,
    note: aiCheck ? 'aiCheck sent a 1-token generateContent request with the configured key and model.' : 'Configuration check only; add ?check=ai to verify the Gemini key and model.'
  });
}
module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
