// Safe deployment health check. Reports configuration presence only; never returns secret values.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const providers = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    socq: Boolean(process.env.SOCQ_API_KEY),
    tiktokResearch: Boolean(process.env.TIKTOK_RESEARCH_ACCESS_TOKEN)
  };
  return res.status(200).json({ ok: true, service: 'TrustLens', timestamp: new Date().toISOString(), providers, reviewProviderReady: providers.socq || providers.tiktokResearch, aiReady: providers.gemini, note: 'This is a configuration check, not a live upstream-provider test.' });
};
