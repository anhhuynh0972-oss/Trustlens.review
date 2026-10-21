// End-to-end test against a deployed TrustLens API. This may consume paid provider credits.
// Usage: node tests/live-product-link.js https://YOUR-DEPLOYMENT.vercel.app "https://www.tiktok.com/shop/pdp/.../1234567890123456789"
const base = (process.argv[2] || '').replace(/\/+$/, '');
const productUrl = process.argv[3] || '';
if (!/^https:\/\//i.test(base) || !productUrl) {
  console.error('Usage: node tests/live-product-link.js https://YOUR-DEPLOYMENT.vercel.app "https://www.tiktok.com/shop/pdp/.../1234567890123456789"');
  process.exit(2);
}
(async () => {
  const healthRes = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15000) });
  const health = await healthRes.json();
  if (!healthRes.ok || !health.reviewProviderReady) {
    throw new Error('Deployed TrustLens has no configured review provider. Configure SOCQ_API_KEY (or an eligible official TikTok token) in Vercel and redeploy.');
  }
  const res = await fetch(`${base}/api/tiktok-review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: productUrl }), signal: AbortSignal.timeout(70000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Real product-link test failed with HTTP ${res.status}: ${data.error || 'No error detail returned'}`);
  if (!Array.isArray(data.reviews) || data.reviews.length === 0) throw new Error('Provider returned no review records. No success is claimed.');
  if (!data.reviews.some(r => typeof r.text === 'string' && r.text.trim())) throw new Error('Provider response contained no review text.');
  console.log(`PASS: ${data.source || 'Configured provider'} returned ${data.reviews.length} non-empty review records.`);
  console.log(`Product: ${data.product?.name || 'name unavailable'}`);
  console.log('Next: verify the same link in the deployed browser and confirm Gemini summary/evidence IDs match these records.');
})().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1); });
