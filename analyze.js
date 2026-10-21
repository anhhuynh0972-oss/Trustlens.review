// Vercel serverless function: AI interpretation only; counts/evidence are validated in the browser.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) return res.status(404).json({ error: 'AI interpretation is not configured. Add GEMINI_API_KEY in Vercel Environment Variables.' });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const reviews = Array.isArray(body.reviews) ? body.reviews : [];
    const language = body.language === 'vi' ? 'Vietnamese' : 'English';
    if (!reviews.length || reviews.length > 200) return res.status(400).json({ error: 'Provide between 1 and 200 reviews.' });
    const safeReviews = reviews.map(r => ({ id: String(r.id || '').slice(0, 80), text: String(r.text || '').slice(0, 2500) })).filter(r => r.id && r.text);
    if (!safeReviews.length) return res.status(400).json({ error: 'No usable review text was provided.' });
    const prompt = `You are TrustLens, an evidence-grounded review interpretation assistant. Respond in ${language}. Return ONLY valid JSON with keys: summary (string), strengths (array of objects {title, evidence_review_ids}), weaknesses (array of objects {title, evidence_review_ids}), potential_concerns (array of objects {title, rationale, evidence_review_ids}), limitations (array of strings). Use only supplied reviews. Never invent text, counts, citations, seller details, product details, or facts. A repeated pattern is a signal to investigate, not proof of fake reviews or fraud. Each evidence_review_ids value must exactly match a supplied review ID and directly support the claim. Do not calculate percentages. Mention that review text alone cannot establish authenticity. In the summary, include a short practical before-buying checklist and a cautious decision suggestion grounded in the supplied evidence (e.g., compare repeated complaints, check return/warranty terms, verify seller details). Do not make unsupported guarantees or claim that you can resolve product defects directly. Reviews JSON:\n${JSON.stringify(safeReviews)}`;
    const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } })
    });
    if (!upstream.ok) return res.status(502).json({ error: 'Gemini API request failed. Check the API key, quota, and model access.' });
    const payload = await upstream.json();
    const raw = payload.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    let ai; try { ai = JSON.parse(raw); } catch { return res.status(502).json({ error: 'AI provider returned invalid structured output.' }); }
    if (typeof ai.summary !== 'string' || !Array.isArray(ai.strengths) || !Array.isArray(ai.potential_concerns) || !Array.isArray(ai.limitations)) return res.status(502).json({ error: 'AI response did not match the expected schema.' });
    const ids = new Set(safeReviews.map(r => r.id));
    for (const key of ['strengths', 'weaknesses', 'potential_concerns']) {
      if (!Array.isArray(ai[key])) ai[key] = [];
      ai[key] = ai[key].map(x => ({ ...x, evidence_review_ids: Array.isArray(x.evidence_review_ids) ? [...new Set(x.evidence_review_ids.filter(id => ids.has(id)))] : [] })).filter(x => x.evidence_review_ids.length);
    }
    return res.status(200).json({ ai });
  } catch (e) {
    return res.status(500).json({ error: 'AI analysis failed. Please retry.' });
  }
};
