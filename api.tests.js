// Handler tests for api/tiktok-review.js and api/analyze.js. Every provider/AI response here is a MOCK
// (tagged [mock]); these tests prove handler logic, not live data availability.
(function () {
  const node = typeof module === 'object' && module.exports;
  const H = node ? require('./harness.js') : TL_test;
  const load = node ? p => Promise.resolve(require('../' + p)) : p => TL_loadCjs(p);
  const proc = node ? process : window.process;
  const { test, mockRes, jsonResponse } = H;
  const PID = '1729384756473829104';
  const URL_OK = `https://www.tiktok.com/shop/pdp/tai-nghe/${PID}`;
  const publicDns = async () => ['23.45.67.89'];
  const fastClock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

  // Social Fetch mock: `pages` = array of review arrays; options inject failures per page.
  function sfMock(pages, opts) {
    opts = opts || {};
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url: String(url), headers: init && init.headers });
      const u = new URL(String(url));
      const page = Number(u.searchParams.get('page'));
      if (opts.fail && opts.fail[page]) { const f = opts.fail[page]; if (typeof f === 'function') return f(); }
      if (opts.notFound) return jsonResponse(200, { data: { lookupStatus: 'not_found', reviews: [], page: { currentPage: 1, nextPage: null, hasMore: false } } });
      const items = pages[page - 1] || [];
      const more = page < pages.length;
      return jsonResponse(200, { data: { lookupStatus: 'found', reviews: items, page: { currentPage: page, nextPage: more ? page + 1 : null, hasMore: more }, summary: { totalReviews: opts.total ?? null, averageRating: 4.6 } }, meta: { creditsCharged: 1 } });
    };
    return { fetchFn, calls };
  }
  const sfReview = i => ({ id: 'SF' + i, productId: PID, rating: (i % 5) + 1, text: 'Đánh giá số ' + i, createdAt: '2026-09-0' + ((i % 9) + 1) + 'T10:00:00Z', verifiedPurchase: i % 2 === 0, reviewer: { name: 'u' + i }, media: { imageUrls: [] } });
  const range = (a, b) => Array.from({ length: b - a }, (_, k) => sfReview(a + k));

  async function callReview(body, deps) {
    const mod = await load('api/tiktok-review.js');
    const res = mockRes();
    await mod.handler({ method: 'POST', body }, res, deps);
    return res;
  }
  const env = extra => Object.assign({ SOCIALFETCH_API_KEY: 'sfk_test_not_real', REVIEW_REGION: 'VN' }, extra || {});

  test('review API: no provider configured -> 503, no demo data', async a => {
    const r = await callReview({ url: URL_OK }, { env: {}, lookup: publicDns });
    a.equal(r.statusCode, 503); a.equal(r.body.error, 'provider_not_configured'); a.ok(!r.body.reviews);
  });
  test('review API: rejects GET and invalid URLs before calling the provider', async a => {
    const mod = await load('api/tiktok-review.js'); const res = mockRes();
    await mod.handler({ method: 'GET' }, res, { env: env() }); a.equal(res.statusCode, 405);
    const m = sfMock([range(0, 3)]);
    const r = await callReview({ url: 'https://evil.example/shop/pdp/' + PID }, { env: env(), fetch: m.fetchFn, lookup: publicDns });
    a.equal(r.statusCode, 400); a.equal(r.body.code, 'host'); a.equal(m.calls.length, 0);
  }, { mock: true });
  test('review API (Social Fetch): fetches all pages, region VN, key only in header, complete', async a => {
    const m = sfMock([range(0, 10), range(10, 20), range(20, 23)], { total: 23 });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 200); a.equal(r.body.complete, true); a.equal(r.body.stopReason, 'exhausted');
    a.equal(r.body.reviews.length, 23); a.equal(r.body.batch.pagesFetched, 3); a.equal(r.body.reportedTotal, 23);
    a.equal(r.body.reviews[0].reviewId, 'SF0'); a.equal(r.body.reviews[0].verifiedPurchase, true); a.equal(r.body.reviews[0].source, 'socialfetch');
    a.ok(m.calls.every(c => c.url.includes('region=VN') && !c.url.includes('sfk_')), 'key must not be in URL');
    a.equal(m.calls[0].headers['x-api-key'], 'sfk_test_not_real');
    a.ok(!JSON.stringify(r.body).includes('sfk_test_not_real'), 'key must not be in response');
  }, { mock: true });
  test('review API: page cap returns partial + resume token; resume continues to completion', async a => {
    const m = sfMock([range(0, 10), range(10, 20), range(20, 30), range(30, 35)], { total: 35 });
    const first = await callReview({ url: URL_OK }, { env: env({ REVIEW_MAX_PAGES: '2' }), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(first.body.complete, false); a.equal(first.body.stopReason, 'page_cap'); a.equal(first.body.reviews.length, 20);
    // Same page cap reached overall -> server refuses more pages
    const capped = await callReview({ url: URL_OK, pagesSoFar: 2, resume: first.body.resume }, { env: env({ REVIEW_MAX_PAGES: '2' }), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(capped.body.reviews.length, 0); a.equal(capped.body.stopReason, 'page_cap');
    // With a higher cap the client resumes from the cursor
    const second = await callReview({ url: URL_OK, pagesSoFar: 2, resume: first.body.resume }, { env: env({ REVIEW_MAX_PAGES: '10' }), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(second.body.complete, true); a.equal(second.body.reviews.length, 15); a.equal(second.body.reviews[0].reviewId, 'SF20');
  }, { mock: true });
  test('review API: duplicate reviews across pages are counted once', async a => {
    const m = sfMock([range(0, 10), range(5, 12)], { total: 12 });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.reviews.length, 12); a.equal(r.body.batch.duplicates, 5); a.equal(r.body.batch.retrieved, 17);
  }, { mock: true });
  test('review API: empty and missing fields are skipped or left null', async a => {
    const m = sfMock([[{ id: 'A', text: null, rating: 5 }, { id: 'B', text: '  ', rating: 4 }, { id: 'C', text: 'Ok', rating: null, createdAt: null, verifiedPurchase: null, reviewer: null, media: null }]]);
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.reviews.length, 1); a.equal(r.body.batch.skippedEmpty, 2);
    const c = r.body.reviews[0]; a.equal(c.rating, null); a.equal(c.date, null); a.equal(c.verifiedPurchase, null); a.equal(c.author, null);
    a.equal(r.body.reportedTotal, null, 'missing total must stay null, not be guessed');
  }, { mock: true });
  test('review API: zero reviews from provider -> honest empty, complete', async a => {
    const m = sfMock([[]], { total: 0 });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 200); a.equal(r.body.reviews.length, 0); a.ok(r.body.complete);
  }, { mock: true });
  test('review API: bad token -> auth_failed, no retries', async a => {
    const m = sfMock([range(0, 5)], { fail: { 1: () => jsonResponse(401, { error: { code: 'unauthorized' } }) } });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'auth_failed'); a.equal(m.calls.length, 1); a.equal(r.body.ok, false);
  }, { mock: true });
  test('review API: credits exhausted mid-way keeps partial results', async a => {
    const m = sfMock([range(0, 10), range(10, 20)], { fail: { 2: () => jsonResponse(402, { error: { code: 'insufficient_credits' } }) }, total: 20 });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 200); a.equal(r.body.reviews.length, 10); a.equal(r.body.stopReason, 'credits_exhausted'); a.equal(r.body.complete, false);
  }, { mock: true });
  test('review API: 503 concurrency limit retried with Retry-After, then succeeds', async a => {
    let n = 0;
    const orig = sfMock([range(0, 4)]).fetchFn;
    const fetchFn = async (u, i) => { const x = new URL(String(u)); if (x.searchParams.get('page') === '1' && n < 2) { n++; return jsonResponse(503, {}, { 'retry-after': '1' }); } return orig(u, i); };
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.complete, true); a.equal(r.body.batch.retries, 2); a.equal(r.body.reviews.length, 4);
  }, { mock: true });
  test('review API: persistent 429 -> rate_limited with resume token', async a => {
    const fetchFn = async u => { const p = new URL(String(u)).searchParams.get('page'); if (p === '1') return jsonResponse(200, { data: { lookupStatus: 'found', reviews: range(0, 10), page: { currentPage: 1, nextPage: 2, hasMore: true } } }); return jsonResponse(429, {}); };
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'rate_limited'); a.equal(r.body.reviews.length, 10); a.equal(r.body.resume.cursor, '2');
  }, { mock: true });
  test('review API: stalled pagination (same reviews every page) is stopped', async a => {
    const fetchFn = async u => { const p = Number(new URL(String(u)).searchParams.get('page')); return jsonResponse(200, { data: { lookupStatus: 'found', reviews: range(0, 5), page: { currentPage: p, nextPage: p + 1, hasMore: true } } }); };
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'stalled'); a.equal(r.body.reviews.length, 5); a.equal(r.body.complete, false);
  }, { mock: true });
  test('review API: product not found in region -> 404 not_found', async a => {
    const m = sfMock([], { notFound: true });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 404); a.equal(r.body.stopReason, 'not_found');
  }, { mock: true });
  test('review API: forged resume token is rejected', async a => {
    const m = sfMock([range(0, 3)]);
    const r = await callReview({ url: URL_OK, resume: { provider: 'socialfetch', cursor: 'x\u0000y' } }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 422);
    const r2 = await callReview({ url: URL_OK, resume: { provider: 'socialfetch', cursor: 'abc' } }, { env: env(), fetch: m.fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r2.body.stopReason, 'provider_rejected');
  }, { mock: true });
  test('review API: provider lookup_failed is reported as such (retryable), not as a generic error', async a => {
    const fetchFn = async () => jsonResponse(502, { error: { code: 'lookup_failed', message: 'upstream lookup failed', requestId: 'r1' } });
    const r = await callReview({ url: URL_OK }, { env: env(), fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 502); a.equal(r.body.stopReason, 'lookup_failed'); a.equal(r.body.retryable, true);
    a.deepEqual(r.body.diagnostic, { httpStatus: 502, providerCode: 'lookup_failed' }); a.equal(r.body.batch.retries, 3, 'retried per provider guidance');
  }, { mock: true });
  test('review API: provider 500, non-JSON body and bad key each give a distinct structured error', async a => {
    let r = await callReview({ url: URL_OK }, { env: env(), fetch: async () => jsonResponse(500, { error: { code: 'internal_error' } }), lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'upstream_error'); a.equal(r.body.diagnostic.httpStatus, 500); a.equal(r.body.diagnostic.providerCode, 'internal_error'); a.equal(r.body.retryable, true);
    r = await callReview({ url: URL_OK }, { env: env(), fetch: async () => jsonResponse(200, '<html>blocked</html>'), lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'bad_response'); a.equal(r.body.ok, false);
    r = await callReview({ url: URL_OK }, { env: env(), fetch: async () => jsonResponse(401, { error: { code: 'unauthorized' } }), lookup: publicDns, ...fastClock() });
    a.equal(r.body.stopReason, 'auth_failed'); a.equal(r.body.retryable, false); a.equal(r.body.diagnostic.providerCode, 'unauthorized');
    r = await callReview({ url: 'https://www.tiktok.com/@shop/video/7300000000000000000' }, { env: env(), lookup: publicDns });
    a.equal(r.body.code, 'no_product_id'); a.equal(r.body.retryable, false);
  }, { mock: true });
  test('review API: an unexpected crash still returns structured JSON (500 server_error)', async a => {
    const mod = await load('api/tiktok-review.js');
    const res = mockRes();
    await mod({ get method() { throw new Error('boom'); } }, res);
    a.equal(res.statusCode, 500); a.equal(res.body.error, 'server_error'); a.equal(res.body.retryable, true);
  });
  test('review API (SocQ): submit once, poll, follow cursors to completion', async a => {
    const calls = [];
    let polls = 0;
    const fetchFn = async (url, init) => {
      const u = String(url); calls.push((init && init.method || 'GET') + ' ' + u);
      if (u.endsWith('/v1/tiktok-shop/product-reviews')) { const b = JSON.parse(init.body); a.equal(b.region, 'VN'); a.ok(b.results_limit >= 20); return jsonResponse(200, { code: 200, data: { task_id: 'task_1', status: 'queued' } }); }
      if (u.includes('limit=1')) return jsonResponse(200, { data: { status: ++polls < 2 ? 'running' : 'succeeded', result_count: 3 } });
      const cur = new URL(u).searchParams.get('cursor');
      if (!cur) return jsonResponse(200, { data: { status: 'succeeded', result_count: 3, results: { items: [{ id: 'q1', text: 'Tốt', rating: 5 }, { id: 'q2', text: 'Ổn', rating: 4 }], next_cursor: 'n2', has_more: true } } });
      return jsonResponse(200, { data: { status: 'succeeded', result_count: 3, results: { items: [{ id: 'q3', text: 'Kém', rating: 1, published_at: '2026-09-01T00:00:00Z' }], next_cursor: null, has_more: false } } });
    };
    const r = await callReview({ url: URL_OK }, { env: { SOCQ_API_KEY: 'socq_test_not_real' }, fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.body.provider.name, 'socq'); a.equal(r.body.complete, true); a.equal(r.body.reviews.length, 3); a.equal(r.body.reportedTotal, 3);
    a.equal(calls.filter(c => c.startsWith('POST')).length, 1, 'submit must not be repeated');
  }, { mock: true });
  test('review API (SocQ): still processing at time budget -> 202 with task resume token', async a => {
    const fetchFn = async (url) => String(url).endsWith('/product-reviews') ? jsonResponse(200, { data: { task_id: 'task_slow' } }) : jsonResponse(200, { data: { status: 'running' } });
    const r = await callReview({ url: URL_OK }, { env: { SOCQ_API_KEY: 'k' }, fetch: fetchFn, lookup: publicDns, ...fastClock() });
    a.equal(r.statusCode, 202); a.equal(r.body.pending, true); a.equal(r.body.resume.taskId, 'task_slow'); a.equal(r.body.reviews.length, 0);
  }, { mock: true });

  // ---- AI analysis endpoint ----
  function geminiMock(handlerFn) {
    const calls = [];
    return { calls, fetchFn: async (url, init) => { calls.push(JSON.parse(init.body)); return handlerFn(calls.length, JSON.parse(init.body)); } };
  }
  const geminiOk = obj => jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
  async function callAnalyze(body, fetchFn, key) {
    const mod = await load('api/analyze.js');
    const old = proc.env.GEMINI_API_KEY;
    if (key === undefined) proc.env.GEMINI_API_KEY = 'gem_test_not_real'; else if (key === null) delete proc.env.GEMINI_API_KEY;
    try { const res = mockRes(); await mod.handler({ method: 'POST', body }, res, { fetch: fetchFn }); return res; }
    finally { if (old === undefined) delete proc.env.GEMINI_API_KEY; else proc.env.GEMINI_API_KEY = old; }
  }
  const batch = [{ id: 'R1', text: 'Pin yếu, sạc không vào', rating: 2 }, { id: 'R2', text: 'Âm thanh hay', rating: 5 }];
  test('analyze API: missing key -> 503 ai_not_configured (no fake result)', async a => {
    const r = await callAnalyze({ reviews: batch }, async () => { throw new Error('should not call'); }, null);
    a.equal(r.statusCode, 503); a.equal(r.body.error, 'ai_not_configured');
  });
  test('analyze API: valid structured output is validated (unknown IDs dropped)', async a => {
    const g = geminiMock(() => geminiOk({ findings: [{ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', rationale: 'x', review_ids: ['R1', 'R99'] }], sentiment: [{ id: 'R1', label: 'negative' }, { id: 'R2', label: 'positive' }] }));
    const r = await callAnalyze({ reviews: batch, language: 'vi' }, g.fetchFn);
    a.equal(r.statusCode, 200); a.deepEqual(r.body.findings[0].reviewIds, ['R1']); a.deepEqual(r.body.analyzedIds, ['R1', 'R2']);
    a.ok(g.calls[0].generationConfig.responseSchema, 'uses structured output schema');
    a.match(g.calls[0].contents[0].parts[0].text, /Vietnamese/);
  }, { mock: true });
  test('analyze API: invalid JSON is retried once, then succeeds', async a => {
    const g = geminiMock(n => n === 1 ? jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{not json' }] } }] }) : geminiOk({ findings: [], sentiment: [] }));
    const r = await callAnalyze({ reviews: batch }, g.fetchFn);
    a.equal(r.statusCode, 200); a.equal(g.calls.length, 2);
  }, { mock: true });
  test('analyze API: persistent invalid output -> 502 ai_invalid_output (surfaced, not faked)', async a => {
    const g = geminiMock(() => geminiOk({ summary: 'wrong shape' }));
    const r = await callAnalyze({ reviews: batch }, g.fetchFn);
    a.equal(r.statusCode, 502); a.equal(r.body.error, 'ai_invalid_output'); a.equal(g.calls.length, 2);
  }, { mock: true });
  test('analyze API: Gemini 429 and auth errors map to safe messages', async a => {
    let r = await callAnalyze({ reviews: batch }, async () => jsonResponse(429, {}));
    a.equal(r.statusCode, 429); a.equal(r.body.error, 'ai_rate_limited');
    r = await callAnalyze({ reviews: batch }, async () => jsonResponse(403, { error: { message: 'API key not valid. key=gem_test_not_real' } }));
    a.equal(r.body.error, 'ai_auth'); a.ok(!JSON.stringify(r.body).includes('gem_test'), 'no upstream details leaked');
  }, { mock: true });
  test('analyze API: payload limits enforced', async a => {
    const big = Array.from({ length: 101 }, (_, i) => ({ id: 'X' + i, text: 't' }));
    let r = await callAnalyze({ reviews: big }, async () => geminiOk({ findings: [], sentiment: [] }));
    a.equal(r.statusCode, 413);
    r = await callAnalyze({ reviews: [] }, async () => geminiOk({}));
    a.equal(r.statusCode, 400);
  }, { mock: true });
  test('analyze API: summary mode uses merged findings and returns structured lists', async a => {
    const g = geminiMock(() => geminiOk({ summary: 'Tóm tắt', positives: ['Âm thanh'], negatives: ['Pin'], recurring_complaints: ['Pin'], quality_insights: [], before_buying: ['Kiểm tra bảo hành'] }));
    const r = await callAnalyze({ mode: 'summary', language: 'vi', analyzed: 2, retrieved: 2, findings: [{ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', count: 1 }] }, g.fetchFn);
    a.equal(r.statusCode, 200); a.equal(r.body.summary.summary, 'Tóm tắt'); a.match(g.calls[0].contents[0].parts[0].text, /"count":1/);
  }, { mock: true });

  test('analyze API: summary works with no findings and passes the computed stance', async a => {
    const g = geminiMock(() => geminiOk({ summary: 'S', positives: [], negatives: [], recurring_complaints: [], quality_insights: [], before_buying: ['Kiểm tra'], decision_rationale: 'Bằng chứng trái chiều.' }));
    const r = await callAnalyze({ mode: 'summary', language: 'vi', analyzed: 12, retrieved: 12, stance: 'mixed', counts: { positive: 6, neutral: 3, negative: 3 }, unknowns: ['no_seller', 'BAD;'], findings: [] }, g.fetchFn);
    a.equal(r.statusCode, 200); a.equal(r.body.summary.decision_rationale, 'Bằng chứng trái chiều.');
    const prompt = g.calls[0].contents[0].parts[0].text;
    a.match(prompt, /"mixed"/); a.match(prompt, /"positive":6/); a.ok(!prompt.includes('BAD;'), 'unknowns sanitised');
    a.ok(g.calls[0].generationConfig.responseSchema.required.includes('decision_rationale'));
    const bad = await callAnalyze({ mode: 'summary', findings: [], counts: {} }, g.fetchFn);
    a.equal(bad.statusCode, 400);
  }, { mock: true });
  test('analyze API: batch prompt asks for positive/neutral/negative only', async a => {
    const g = geminiMock(() => geminiOk({ findings: [], sentiment: [] }));
    await callAnalyze({ reviews: batch }, g.fetchFn);
    a.deepEqual(g.calls[0].generationConfig.responseSchema.properties.sentiment.items.properties.label.enum, ['positive', 'neutral', 'negative']);
  }, { mock: true });

  test('analyze API: invalid Gemini key (Google 400) -> ai_auth with status only, no retry', async a => {
    const g = geminiMock(() => jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }));
    const r = await callAnalyze({ reviews: batch }, g.fetchFn);
    a.equal(r.body.error, 'ai_auth'); a.deepEqual(r.body.upstream, { http: 400, status: 'INVALID_ARGUMENT' }); a.equal(g.calls.length, 1);
    const m = await callAnalyze({ reviews: batch }, async () => jsonResponse(404, { error: { status: 'NOT_FOUND', message: 'models/x is not found' } }));
    a.equal(m.body.error, 'ai_model_unavailable');
  }, { mock: true });
  test('health API: ?check=ai verifies key + model via free lookup and reports status only', async a => {
    const mod = await load('api/health.js');
    let seen = null;
    const res = mockRes();
    await mod.handler({ method: 'GET', query: { check: 'ai' } }, res, { env: { GEMINI_API_KEY: 'gem_secret_x' }, fetch: async (url, init) => { seen = { url: String(url), key: init.headers['x-goog-api-key'] }; return jsonResponse(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }); } });
    a.match(seen.url, /\/v1beta\/models\/gemini-2\.5-flash$/); a.equal(seen.key, 'gem_secret_x');
    a.deepEqual(res.body.aiCheck, { ok: false, model: 'gemini-2.5-flash', http: 400, status: 'INVALID_ARGUMENT' });
    a.ok(!JSON.stringify(res.body).includes('gem_secret_x'));
    const plain = mockRes(); await mod.handler({ method: 'GET', query: {} }, plain, { env: {} });
    a.equal(plain.body.aiCheck, undefined);
  }, { mock: true });

  // ---- mode "report" (mocked Gemini) ----
  const rpFindings = [
    { kind: 'positive', category: 'performance', title: 'Âm thanh rõ', count: 3, reviewIds: ['P1', 'P2', 'P3'], excerpts: [{ reviewId: 'P1', text: 'Âm thanh rõ' }] },
    { kind: 'negative', category: 'battery_charging', title: 'Pin yếu', count: 1, reviewIds: ['N1'], excerpts: [{ reviewId: 'N1', text: 'Pin yếu' }] }
  ];
  test('report API: keeps only real finding refs and review IDs, computes support, sanitises', async a => {
    const g = geminiMock(() => geminiOk({ product_category: 'tai nghe',
      positives: [{ heading: 'Âm thanh rõ', explanation: 'Khách khen âm thanh.', finding_refs: [0, 1, 9], review_ids: ['P2', 'N1', 'FAKE'] }, { heading: 'Bịa', explanation: 'x', finding_refs: [7], review_ids: ['P1'] }],
      negatives: [{ heading: 'Pin yếu', explanation: 'Một khách phàn nàn.', impact: 'Phải sạc nhiều', finding_refs: [1], review_ids: [] }, { heading: 'Sai loại', explanation: 'x', finding_refs: [0] }],
      no_clear_negative: false, before_buying: ['Kiểm tra bảo hành'] }));
    const r = await callAnalyze({ mode: 'report', language: 'vi', analyzed: 4, retrieved: 4, findings: rpFindings }, g.fetchFn);
    a.equal(r.statusCode, 200);
    const rp = r.body.report;
    a.equal(rp.positives.length, 1, 'theme with only invalid refs dropped');
    a.deepEqual(rp.positives[0].finding_refs, [0], 'negative ref removed from a positive theme');
    a.deepEqual(rp.positives[0].review_ids, ['P2'], 'IDs outside the referenced findings dropped');
    a.equal(rp.positives[0].support, 3);
    a.equal(rp.negatives.length, 1, 'positive finding cannot back a negative theme');
    a.deepEqual(rp.negatives[0].review_ids, ['N1'], 'empty IDs filled from the finding'); a.equal(rp.negatives[0].support, 1);
    a.equal(rp.no_clear_negative, false);
    a.match(g.calls[0].contents[0].parts[0].text, /Vietnamese/); a.ok(g.calls[0].generationConfig.responseSchema.required.includes('before_buying'));
  }, { mock: true });
  test('report API: no negative findings -> no_clear_negative even if the model claims negatives', async a => {
    const g = geminiMock(() => geminiOk({ product_category: '', positives: [], negatives: [{ heading: 'x', explanation: 'y', finding_refs: [0] }], no_clear_negative: false, before_buying: [] }));
    const r = await callAnalyze({ mode: 'report', findings: [rpFindings[0]], analyzed: 3 }, g.fetchFn);
    a.equal(r.body.report.negatives.length, 0); a.equal(r.body.report.no_clear_negative, true);
  }, { mock: true });
  test('report API: no findings -> 400; Gemini errors and invalid output surface as codes', async a => {
    let r = await callAnalyze({ mode: 'report', findings: [] }, async () => geminiOk({}));
    a.equal(r.statusCode, 400); a.equal(r.body.error, 'no_findings');
    r = await callAnalyze({ mode: 'report', findings: rpFindings }, async () => jsonResponse(429, {}));
    a.equal(r.body.error, 'ai_rate_limited');
    const g = geminiMock(() => geminiOk({ positives: 'nope' }));
    r = await callAnalyze({ mode: 'report', findings: rpFindings }, g.fetchFn);
    a.equal(r.body.error, 'ai_invalid_output'); a.equal(g.calls.length, 2, 'retried once');
  }, { mock: true });

  // ---- Health ----
  test('health API: reports booleans only, never values', async a => {
    const mod = await load('api/health.js');
    proc.env.SOCIALFETCH_API_KEY = 'sfk_secret_value';
    try { const res = mockRes(); await mod({ method: 'GET' }, res); a.equal(res.body.providers.socialfetch, true); a.ok(!JSON.stringify(res.body).includes('sfk_secret_value')); }
    finally { delete proc.env.SOCIALFETCH_API_KEY; }
  });
})();
