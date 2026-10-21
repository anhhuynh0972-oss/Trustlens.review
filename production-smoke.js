// Run after deployment: npm run test:production -- https://your-project.vercel.app
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\//i.test(base)) {
  console.error('Usage: npm run test:production -- https://your-project.vercel.app');
  process.exit(2);
}
let failed = false;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed = true; console.error(`FAIL ${name}: ${e.message}`); }
}
(async () => {
  await check('homepage responds with HTML', async () => {
    const r = await fetch(base, { signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    if (!r.ok || !t.includes('TrustLens') || !t.includes('languageToggle')) throw new Error(`HTTP ${r.status}; expected TrustLens HTML and language toggle`);
  });
  await check('health endpoint responds and does not expose secrets', async () => {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (!r.ok || d.ok !== true || !d.providers || typeof d.providers.gemini !== 'boolean') throw new Error(`unexpected health response (HTTP ${r.status})`);
    if (JSON.stringify(d).match(/AIza[\w-]{20,}|Bearer\s+\S+/i)) throw new Error('possible secret in response');
    console.log(`     AI configured: ${d.aiReady}; review provider configured: ${d.reviewProviderReady}`);
  });
  await check('review endpoint rejects GET safely', async () => {
    const r = await fetch(`${base}/api/tiktok-review`, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (r.status !== 405) throw new Error(`expected HTTP 405, got ${r.status}`);
  });
  await check('AI endpoint rejects GET safely', async () => {
    const r = await fetch(`${base}/api/analyze`, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (r.status !== 405) throw new Error(`expected HTTP 405, got ${r.status}`);
  });
  if (failed) process.exit(1);
  console.log('\nSmoke checks passed. This does not prove the provider can retrieve a specific Vietnam product; run a real product-link test in the UI.');
})().catch(e => { console.error(e); process.exit(1); });
