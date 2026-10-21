// Unit tests for lib/url.js, lib/retrieve.js and lib/analysis.js (no network).
(function () {
  const node = typeof module === 'object' && module.exports;
  const H = node ? require('./harness.js') : TL_test;
  const U = node ? require('../lib/url.js') : TL_url;
  const R = node ? require('../lib/retrieve.js') : TL_retrieve;
  const A = node ? require('../lib/analysis.js') : TL_analysis;
  const { test } = H;
  const PID = '1729384756473829104';

  // ---- URL validation ----
  test('url: accepts PDP links with and without slug, adds https, strips hash', async a => {
    for (const input of [`https://www.tiktok.com/shop/pdp/ao-thun-nam/${PID}`, `https://www.tiktok.com/shop/pdp/${PID}?source=share#x`, `www.tiktok.com/shop/pdp/${PID}`, `https://shop.tiktok.com/view/product/${PID}?region=VN`]) {
      const r = await U.normalizeProductUrl(input);
      a.equal(r.productId, PID, input);
      a.equal(r.canonicalUrl, 'https://www.tiktok.com/shop/pdp/' + PID);
    }
  });
  test('url: product_id query parameter is used', async a => {
    a.equal((await U.normalizeProductUrl(`https://www.tiktok.com/view/product?product_id=${PID}`)).productId, PID);
  });
  test('url: rejects non-TikTok, look-alike, IP, credential, custom-port and non-http links', async a => {
    const bad = { 'https://evil.com/shop/pdp/1729384756473829104': 'host', 'https://tiktok.com.evil.com/x': 'host', 'https://eviltiktok.com/x': 'host', 'http://127.0.0.1/x': 'ip_host', 'http://[::1]/x': 'ip_host',
      'https://user:pw@www.tiktok.com/shop/pdp/1729384756473829104': 'credentials', 'https://www.tiktok.com:8443/shop/pdp/1729384756473829104': 'port', 'ftp://www.tiktok.com/x': 'scheme', 'javascript:alert(1)': 'invalid', '': 'empty' };
    for (const [input, code] of Object.entries(bad)) await a.rejects(U.normalizeProductUrl(input), e => a.equal(e.code, code, input));
  });
  test('url: TikTok video/profile link without product ID is rejected', async a => {
    await a.rejects(U.normalizeProductUrl('https://www.tiktok.com/@shop/video/7300000000000000000'), e => a.equal(e.code, 'no_product_id'));
  });
  test('url: private IP detection', a => {
    ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0'].forEach(ip => a.ok(U.isPrivateIp(ip), ip));
    ['8.8.8.8', '23.45.67.89', '2606:4700::1111'].forEach(ip => a.ok(!U.isPrivateIp(ip), ip));
  });

  // ---- Short-link redirects (mocked network) ----
  const redirectFetch = map => async url => { const loc = map[url]; return { status: loc ? 302 : 200, headers: { get: k => k === 'location' ? loc || null : null } }; };
  test('redirect: short link resolves through allowed hops to a product', async a => {
    const r = await U.normalizeProductUrl('https://vt.tiktok.com/ZSabc123/', { fetch: redirectFetch({ 'https://vt.tiktok.com/ZSabc123/': `https://www.tiktok.com/shop/pdp/abc/${PID}?_r=1` }), lookup: async () => ['23.45.67.89'] });
    a.equal(r.productId, PID); a.ok(r.wasShortLink);
  }, { mock: true });
  test('redirect: hop to a non-TikTok host is refused (SSRF guard)', async a => {
    await a.rejects(U.normalizeProductUrl('https://vt.tiktok.com/x/', { fetch: redirectFetch({ 'https://vt.tiktok.com/x/': 'http://169.254.169.254/latest/meta-data' }) }), e => a.equal(e.code, 'redirect_host'));
  }, { mock: true });
  test('redirect: TikTok host resolving to a private IP is refused', async a => {
    await a.rejects(U.normalizeProductUrl('https://vt.tiktok.com/x/', { fetch: redirectFetch({}), lookup: async () => ['10.1.2.3'] }), e => a.equal(e.code, 'private_ip'));
  }, { mock: true });
  test('redirect: loops and too many hops are stopped', async a => {
    await a.rejects(U.normalizeProductUrl('https://vt.tiktok.com/a/', { fetch: redirectFetch({ 'https://vt.tiktok.com/a/': 'https://vm.tiktok.com/b/', 'https://vm.tiktok.com/b/': 'https://vt.tiktok.com/a/' }) }), e => a.equal(e.code, 'redirect_loop'));
    const chain = {}; for (let i = 0; i < 10; i++) chain[`https://vt.tiktok.com/${i}/`] = `https://vt.tiktok.com/${i + 1}/`;
    await a.rejects(U.normalizeProductUrl('https://vt.tiktok.com/0/', { fetch: redirectFetch(chain) }), e => a.equal(e.code, 'too_many_redirects'));
  }, { mock: true });
  test('redirect: short link that does not redirect gives a clear error', async a => {
    await a.rejects(U.normalizeProductUrl('https://vt.tiktok.com/dead/', { fetch: redirectFetch({}) }), e => a.equal(e.code, 'resolve_failed'));
  }, { mock: true });

  // ---- Pagination engine (mocked pages) ----
  const norm = (raw, i) => A.normalizeReview(raw, { source: 'mock' });
  const mkItems = (from, n) => Array.from({ length: n }, (_, i) => ({ review_id: 'r' + (from + i), review_text: 'Review number ' + (from + i), review_rating: 5 }));
  const noSleep = async () => {};
  test('paginate: follows every page until provider says no more; marks complete', async a => {
    const pages = { null: { items: mkItems(0, 10), nextCursor: 'c1', hasMore: true, reportedTotal: 25 }, c1: { items: mkItems(10, 10), nextCursor: 'c2', hasMore: true }, c2: { items: mkItems(20, 5), nextCursor: null, hasMore: false } };
    const r = await R.paginate({ fetchPage: async c => pages[c], normalize: norm, sleep: noSleep });
    a.equal(r.complete, true); a.equal(r.stopReason, 'exhausted'); a.equal(r.stats.pagesFetched, 3); a.equal(r.stats.unique, 25); a.equal(r.stats.reportedTotal, 25); a.equal(r.nextCursor, null);
  }, { mock: true });
  test('paginate: dedups overlapping pages by stable review ID', async a => {
    const pages = { null: { items: mkItems(0, 10), nextCursor: 'c1', hasMore: true }, c1: { items: mkItems(5, 10), nextCursor: null, hasMore: false } };
    const r = await R.paginate({ fetchPage: async c => pages[c], normalize: norm, sleep: noSleep });
    a.equal(r.stats.retrieved, 20); a.equal(r.stats.unique, 15); a.equal(r.stats.duplicates, 5);
  }, { mock: true });
  test('paginate: page cap stops with partial result and resume cursor', async a => {
    let n = 0; const r = await R.paginate({ fetchPage: async () => ({ items: mkItems(n++ * 10, 10), nextCursor: 'c' + n, hasMore: true }), normalize: norm, maxPages: 3, sleep: noSleep });
    a.equal(r.complete, false); a.equal(r.stopReason, 'page_cap'); a.equal(r.stats.unique, 30); a.equal(r.nextCursor, 'c3'); a.ok(r.resumable);
  }, { mock: true });
  test('paginate: resume from cursor with seen keys continues without duplicates', async a => {
    const first = await R.paginate({ fetchPage: async c => c == null ? { items: mkItems(0, 10), nextCursor: 'c1', hasMore: true } : null, normalize: norm, maxPages: 1, sleep: noSleep });
    const second = await R.paginate({ startCursor: first.nextCursor, seenKeys: first.seenKeys, fetchPage: async c => ({ items: mkItems(8, 6), nextCursor: null, hasMore: false }), normalize: norm, sleep: noSleep });
    a.equal(second.stats.unique, 4); a.equal(second.stats.duplicates, 2); a.ok(second.complete);
  }, { mock: true });
  test('paginate: stalled pagination (pages with nothing new) is stopped', async a => {
    let n = 0; const r = await R.paginate({ fetchPage: async () => ({ items: mkItems(0, 5), nextCursor: 'c' + (++n), hasMore: true }), normalize: norm, sleep: noSleep });
    a.equal(r.stopReason, 'stalled'); a.equal(r.stats.unique, 5); a.ok(!r.complete);
  }, { mock: true });
  test('paginate: repeated cursor is detected as a loop', async a => {
    const r = await R.paginate({ fetchPage: async c => ({ items: mkItems(c === 'same' ? 10 : 0, 10), nextCursor: 'same', hasMore: true }), normalize: norm, sleep: noSleep });
    a.equal(r.stopReason, 'cursor_loop'); a.equal(r.stats.unique, 20);
  }, { mock: true });
  test('paginate: rate limit is retried with backoff, then succeeds', async a => {
    let calls = 0; const waits = [];
    const r = await R.paginate({ fetchPage: async () => { if (++calls < 3) throw new R.ProviderError('rate_limited', '429', { retryAfterMs: 1000 }); return { items: mkItems(0, 3), hasMore: false }; }, normalize: norm, sleep: async ms => waits.push(ms) });
    a.ok(r.complete); a.equal(r.stats.retries, 2); a.deepEqual(waits, [1000, 1000]);
  }, { mock: true });
  test('paginate: persistent rate limit keeps partial results and is resumable', async a => {
    let calls = 0;
    const r = await R.paginate({ fetchPage: async c => { if (++calls === 1) return { items: mkItems(0, 10), nextCursor: 'c1', hasMore: true }; throw new R.ProviderError('rate_limited', '429'); }, normalize: norm, maxRetries: 2, sleep: noSleep });
    a.equal(r.stopReason, 'rate_limited'); a.equal(r.stats.unique, 10); a.equal(r.nextCursor, 'c1'); a.ok(r.resumable);
  }, { mock: true });
  test('paginate: bad token stops immediately without retry; credits exhaustion keeps partial', async a => {
    let calls = 0;
    const bad = await R.paginate({ fetchPage: async () => { calls++; throw R.classifyHttp(401, '{"error":"invalid key"}'); }, normalize: norm, sleep: noSleep });
    a.equal(bad.stopReason, 'auth_failed'); a.equal(calls, 1); a.ok(!bad.resumable);
    let n = 0;
    const cr = await R.paginate({ fetchPage: async () => { if (n++ === 0) return { items: mkItems(0, 7), nextCursor: 'c1', hasMore: true }; throw R.classifyHttp(402, 'Insufficient credits'); }, normalize: norm, sleep: noSleep });
    a.equal(cr.stopReason, 'credits_exhausted'); a.equal(cr.stats.unique, 7);
  }, { mock: true });
  test('paginate: time budget stops before the deadline and returns resume cursor', async a => {
    let t = 0;
    const r = await R.paginate({ fetchPage: async c => { t += 1000; return { items: mkItems(t, 5), nextCursor: 'c' + t, hasMore: true }; }, normalize: norm, now: () => t, deadlineMs: 2500, sleep: noSleep });
    a.equal(r.stopReason, 'time_budget'); a.equal(r.stats.pagesFetched, 3); a.ok(r.nextCursor);
  }, { mock: true });
  test('classifyHttp maps provider statuses', a => {
    a.equal(R.classifyHttp(200, ''), null);
    a.equal(R.classifyHttp(401, '').kind, 'auth'); a.equal(R.classifyHttp(403, '').kind, 'auth'); a.equal(R.classifyHttp(402, '').kind, 'credits');
    a.equal(R.classifyHttp(429, '', { 'retry-after': '3' }).retryAfterMs, 3000); a.equal(R.classifyHttp(400, 'Insufficient balance').kind, 'credits');
    a.equal(R.classifyHttp(503, '').kind, 'upstream'); a.equal(R.classifyHttp(504, '').kind, 'timeout');
  });

  // ---- Normalization / missing fields ----
  test('normalize: maps provider fields and leaves missing ones null (no invention)', a => {
    const r = A.normalizeReview({ review_id: 'X1', review_text: '  Hàng   đẹp ', review_rating: 'FOUR', review_time: 1700000000, verified_purchase: 'true', images: ['https://p16.tiktokcdn.com/a.jpg', 'javascript:alert(1)'] }, { source: 'socq', productId: '123' });
    a.equal(r.reviewId, 'X1'); a.equal(r.text, 'Hàng đẹp'); a.equal(r.rating, 4); a.equal(r.verifiedPurchase, true); a.equal(r.media.length, 1); a.equal(r.productId, '123'); a.ok(r.date.startsWith('2023-11-14'));
    const m = A.normalizeReview({ text: 'Only text' });
    a.equal(m.rating, null); a.equal(m.date, null); a.equal(m.verifiedPurchase, null); a.ok(m.idDerived); a.match(m.reviewId, /^LOCAL-/);
    a.equal(A.normalizeReview({ review_text: '   ' }), null); a.equal(A.normalizeReview(null), null);
    a.equal(A.normalizeReview({ text: 'x', rating: 9 }).rating, null);
  });
  test('normalize: derived IDs are stable for identical content', a => {
    a.equal(A.normalizeReview({ text: 'Same' }).reviewId, A.normalizeReview({ text: 'Same' }).reviewId);
  });

  // ---- Batching and merge ----
  const many = Array.from({ length: 205 }, (_, i) => A.normalizeReview({ review_id: 'R' + i, review_text: 'Text ' + i + (i % 3 === 0 ? ' pin yếu' : ' âm thanh hay'), review_rating: i % 3 === 0 ? 2 : 5 }));
  test('batching: every review lands in exactly one batch (no silent truncation)', a => {
    const b = A.makeBatches(many, { maxCount: 80 });
    a.equal(b.length, 3); a.equal(b.flat().length, 205); a.equal(new Set(b.flat().map(r => r.reviewId)).size, 205);
    const byChars = A.makeBatches(many, { maxCount: 1000, maxChars: 500 });
    a.equal(byChars.flat().length, 205); a.ok(byChars.length > 3);
  });
  test('validate: drops unknown IDs, bad kinds, empty findings; throws on wrong shape', a => {
    const v = A.validateBatchResult({ findings: [{ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', review_ids: ['R0', 'FAKE'] }, { kind: 'weird', category: 'x', title: 't', review_ids: ['R0'] }, { kind: 'positive', category: 'nope', title: 'Hay', review_ids: ['FAKE'] }], sentiment: [{ id: 'R0', label: 'negative' }, { id: 'FAKE', label: 'positive' }] }, ['R0', 'R1']);
    a.equal(v.findings.length, 1); a.deepEqual(v.findings[0].reviewIds, ['R0']); a.deepEqual(Object.keys(v.sentiment), ['R0']);
    let threw = false; try { A.validateBatchResult({ summary: 'x' }, ['R0']); } catch (e) { threw = true; } a.ok(threw);
  });
  test('merge: unions IDs across batches, counts distinct reviews, attaches real excerpts', a => {
    const res = [
      { findings: [{ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', rationale: 'r', reviewIds: ['R0', 'R3'] }], sentiment: { R0: 'negative', R3: 'negative' } },
      { findings: [{ kind: 'negative', category: 'battery_charging', title: 'Pin nhanh hết', rationale: '', reviewIds: ['R3', 'R81'] }], sentiment: { R81: 'negative' } }
    ];
    const m = A.mergeBatchResults(res, many);
    a.equal(m.findings.length, 1); a.equal(m.findings[0].count, 3); a.equal(m.findings[0].excerpts[0].text, many[0].text);
    a.equal(m.sentimentCounts.negative, 3); a.equal(m.sentimentCounts.unclassified, 202);
  });
  test('signals: duplicate text across IDs is flagged as a concern with real IDs', a => {
    const rs = ['Sản phẩm rất tốt giao nhanh', 'Sản phẩm rất tốt giao nhanh!', 'Khác hoàn toàn'].map((t, i) => A.normalizeReview({ review_id: 'D' + i, review_text: t, review_rating: 5 }));
    const s = A.dataSignals(rs);
    a.equal(s.length, 1); a.equal(s[0].type, 'duplicate_text'); a.deepEqual(s[0].reviewIds, ['D0', 'D1']);
    a.deepEqual(A.dataSignals([]), []);
  });
  // ---- Step 3 + 6: three sentiment labels and the counted decision basis ----
  test('sentiment: only positive/neutral/negative are accepted from the model', a => {
    const v = A.validateBatchResult({ findings: [], sentiment: [{ id: 'R0', label: 'mixed' }, { id: 'R1', label: 'neutral' }] }, ['R0', 'R1']);
    a.deepEqual(v.sentiment, { R1: 'neutral' });
  });
  const mk = (n, lab) => Array.from({ length: n }, (_, i) => A.normalizeReview({ review_id: lab + i, review_text: lab + ' review ' + i, verifiedPurchase: true }));
  function basis(pos, neu, neg, findings, ctx) {
    const rs = [...mk(pos, 'P'), ...mk(neu, 'U'), ...mk(neg, 'N')];
    const sentiment = {}; rs.forEach(r => sentiment[r.reviewId] = r.reviewId[0] === 'P' ? 'positive' : r.reviewId[0] === 'U' ? 'neutral' : 'negative');
    const m = A.mergeBatchResults([{ findings: findings || [], sentiment }], rs);
    return A.decisionBasis(m, rs, Object.assign({ complete: true, sellerData: false }, ctx));
  }
  test('decision: stance follows the documented counting rule', a => {
    a.equal(basis(5, 2, 1).stance, 'insufficient_evidence');
    a.equal(basis(30, 5, 5).stance, 'mostly_positive');
    a.equal(basis(20, 5, 20).stance, 'mostly_negative');
    a.equal(basis(20, 15, 5).stance, 'mixed');
    a.equal(basis(30, 5, 5, [{ kind: 'concern', category: 'authenticity', title: 'x', reviewIds: ['N0', 'N1', 'N2', 'N3'] }]).stance, 'mixed', 'big concern blocks mostly_positive');
    a.equal(basis(30, 5, 5, [], { retrieved: 100 }).stance, 'insufficient_evidence', 'under half classified');
  });
  test('decision: shares and unknowns come from the data', a => {
    const d = basis(30, 5, 5, [], { complete: false, retrieved: 50 });
    a.equal(d.classified, 40); a.equal(d.counts.positive, 30); a.equal(Math.round(d.shares.positive * 1000), 750);
    a.deepEqual(d.unknowns, ['partial_retrieval', 'partial_ai', 'no_seller']);
  });
  test('credibility: ratios are counted from labels, findings and star ratings', a => {
    const rs = [1, 2, 3, 4, 5, 5].map((st, i) => A.normalizeReview({ review_id: 'C' + i, review_text: 't' + i, rating: st }));
    const sentiment = { C0: 'negative', C1: 'positive', C2: 'neutral', C3: 'positive', C4: 'positive', C5: 'negative' };
    const m = A.mergeBatchResults([{ findings: [{ kind: 'negative', category: 'quality', title: 'Hỏng', reviewIds: ['C0', 'C5'] }], sentiment }], rs);
    const c = A.credibilitySignals(m, rs);
    a.deepEqual([c.consistency.k, c.consistency.n, c.consistency.majority], [3, 6, 'positive']);
    a.deepEqual([c.complaintReach.k, c.topComplaint.k, c.topComplaint.title], [2, 2, 'Hỏng']);
    a.equal(Math.round(c.polarityGap * 100), 17);
    a.deepEqual([c.ratingAgreement.k, c.ratingAgreement.n], [4, 6], 'C1 (2★ positive) and C5 (5★ negative) disagree');
  });
  test('certainty: documented thresholds', a => {
    a.equal(A.certaintyLevel(120, 120, true), 'high'); a.equal(A.certaintyLevel(120, 130, true), 'medium');
    a.equal(A.certaintyLevel(120, 120, false), 'medium'); a.equal(A.certaintyLevel(30, 37, true), 'medium'); a.equal(A.certaintyLevel(29, 29, true), 'low');
  });
  test('rating stats ignore missing ratings', a => {
    const s = A.ratingStats([A.normalizeReview({ text: 'a', rating: 5 }), A.normalizeReview({ text: 'b' }), A.normalizeReview({ text: 'c', rating: 3 })]);
    a.equal(s.count, 2); a.equal(s.average, 4);
  });
})();
