// LIVE end-to-end check against a deployed TrustLens (real provider, may consume paid credits).
// Usage: node tests/live-product-link.js https://YOUR-DEPLOYMENT.vercel.app "https://www.tiktok.com/shop/pdp/.../1234567890123456789" [maxCalls]
// Start with a small server page cap (REVIEW_MAX_PAGES=2 in Vercel) for the first run.
const base = (process.argv[2] || '').replace(/\/+$/, '');
const productUrl = process.argv[3] || '';
const maxCalls = Math.max(1, Number(process.argv[4]) || 3);
if (!/^https:\/\//i.test(base) || !productUrl) {
  console.error('Usage: node tests/live-product-link.js https://YOUR-DEPLOYMENT.vercel.app "<TikTok Shop product URL>" [maxCalls]');
  process.exit(2);
}
(async () => {
  const health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15000) })).json();
  console.log('health:', JSON.stringify({ providers: health.providers, region: health.reviewRegion, maxPages: health.maxPages }));
  if (!health.reviewProviderReady) throw new Error('No review provider configured (SOCIALFETCH_API_KEY or SOCQ_API_KEY).');
  let resume = null, pages = 0; const ids = new Set(); let last = null;
  for (let i = 0; i < maxCalls; i++) {
    const res = await fetch(`${base}/api/tiktok-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: productUrl, resume, pagesSoFar: pages }), signal: AbortSignal.timeout(70000) });
    last = await res.json().catch(() => ({}));
    console.log(`call ${i + 1}: HTTP ${res.status} stop=${last.stopReason} complete=${last.complete} pages=${last.batch && last.batch.pagesFetched} got=${(last.reviews || []).length} reportedTotal=${last.reportedTotal}`);
    if (!res.ok && res.status !== 202) throw new Error(`${last.error || 'error'}: ${last.message || ''}`);
    (last.reviews || []).forEach(r => ids.add(r.reviewId));
    pages += (last.batch && last.batch.pagesFetched) || 0;
    resume = last.resume;
    if (last.complete || !resume) break;
  }
  if (!ids.size) throw new Error('Provider returned no review records. No success is claimed.');
  console.log(`PASS (live): ${last.provider && last.provider.label} product ${last.product && last.product.productId}: ${ids.size} unique reviews over ${pages} pages; source reports ${last.reportedTotal ?? 'no total'}; complete=${last.complete}.`);
})().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1); });
