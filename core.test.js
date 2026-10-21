const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('required project files exist', () => {
  for (const file of ['index.html','api/analyze.js','api/tiktok-review.js','api/health.js','data/manifest.json']) assert.ok(fs.existsSync(path.join(root,file)), `missing ${file}`);
});
test('frontend has language toggle and sends language to AI', () => {
  const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(html, /id="languageToggle"/);
  assert.match(html, /language:currentLanguage/);
});
test('review adapter uses provider key only server-side and never demo fallback', () => {
  const api = fs.readFileSync(path.join(root,'api/tiktok-review.js'),'utf8');
  assert.match(api, /SOCQ_API_KEY/);
  assert.match(api, /No sample reviews were substituted/);
  assert.match(api, /\/v1\/tasks\//);
});
test('health endpoint reports config booleans only', () => {
  const api = fs.readFileSync(path.join(root,'api/health.js'),'utf8');
  assert.match(api, /reviewProviderReady/);
  assert.match(api, /Boolean\(process\.env\.GEMINI_API_KEY\)/);
});
test('SocQ adapter normalizes real-provider response shape using mocked upstream only', async () => {
  const handler = require('../api/tiktok-review.js');
  const oldKey = process.env.SOCQ_API_KEY;
  const oldResearch = process.env.TIKTOK_RESEARCH_ACCESS_TOKEN;
  const oldFetch = global.fetch;
  process.env.SOCQ_API_KEY = 'test-key-not-real';
  delete process.env.TIKTOK_RESEARCH_ACCESS_TOKEN;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push(String(url));
    const body = String(url).includes('/v1/tiktok-shop/product-reviews')
      ? { data: { task_id: 'task-test' } }
      : { data: { status: 'succeeded', results: { items: [
          { id: 'rv-1', product_name: 'Test product', review_text: 'Works well', review_rating: 'FIVE' },
          { id: 'rv-2', product_name: 'Test product', review_text: 'Battery is weak', review_rating: 'TWO' }
        ], has_more: false, next_cursor: null } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const output = { code: 200, data: null, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, setHeader() {} };
  try {
    await handler({ method: 'POST', body: { url: 'https://www.tiktok.com/shop/pdp/test-product/1700000000000000000' } }, output);
    assert.equal(output.code, 200);
    assert.equal(output.data.reviews.length, 2);
    assert.equal(output.data.reviews[0].rating, 5);
    assert.equal(output.data.reviews[1].rating, 2);
    assert.match(output.data.source, /SocQ/);
    assert.ok(calls.some(url => url.includes('/v1/tasks/task-test')));
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SOCQ_API_KEY; else process.env.SOCQ_API_KEY = oldKey;
    if (oldResearch === undefined) delete process.env.TIKTOK_RESEARCH_ACCESS_TOKEN; else process.env.TIKTOK_RESEARCH_ACCESS_TOKEN = oldResearch;
  }
});

test('SocQ provider rejects non-product TikTok URLs before making a paid provider call', async () => {
  const handler = require('../api/tiktok-review.js');
  const oldKey = process.env.SOCQ_API_KEY;
  const oldFetch = global.fetch;
  process.env.SOCQ_API_KEY = 'test-key-not-real';
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not call provider'); };
  const output = { code: 200, data: null, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, setHeader() {} };
  try {
    await handler({ method: 'POST', body: { url: 'https://www.tiktok.com/@someone/video/1234567890123456789' } }, output);
    assert.equal(output.code, 422);
    assert.match(output.data.error, /supported TikTok Shop product page/i);
    assert.equal(called, false);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SOCQ_API_KEY; else process.env.SOCQ_API_KEY = oldKey;
  }
});
