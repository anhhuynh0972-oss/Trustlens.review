// Browser-only UI tests: load the real index.html in an iframe, stub ONLY its /api/* calls with mocks,
// and check language toggle, truthful progress, partial/empty/error states and phone-width layout.
(function () {
  if (typeof module === 'object' && module.exports) {
    const H = require('./harness.js');
    ['ui: full site sections', 'ui: navigation', 'ui: every text has a VI translation', 'ui: survey figures', 'ui: six steps end to end', 'ui: demo offline', 'ui: no backend', 'ui: timeout and bad link', 'ui: manual fallback', 'report UI 1-7', 'motion: reveal', 'motion: fallback', 'motion: busy buttons', 'hero: collage + liquid', 'hero: fallbacks', 'ui: language toggle', 'ui: live flow', 'ui: partial', 'ui: empty', 'ui: AI not configured', 'ui: no horizontal overflow'].forEach(n => H.test(n + ' (browser only)', () => {}, { browserOnly: true }));
    return;
  }
  const { test } = TL_test;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function openPage(width, apiStub) {
    const holder = document.getElementById('frames');
    const f = document.createElement('iframe');
    f.style.width = width + 'px'; f.style.height = '700px';
    holder.appendChild(f);
    f.scrollIntoView({ block: 'start', behavior: 'instant' }); // IntersectionObserver in a frame needs the frame on screen
    try { localStorage.removeItem('trustlens.lang'); } catch (e) {}
    await new Promise(res => { f.onload = res; f.src = '../index.html'; });
    const w = f.contentWindow;
    for (let i = 0; i < 50 && !w.TL_live; i++) await sleep(50);
    const realFetch = w.fetch.bind(w);
    w.fetch = (url, init) => String(url).startsWith('/api/') ? apiStub(String(url), init ? JSON.parse(init.body || '{}') : {}) : realFetch(url, init);
    await sleep(200);
    return { f, w, d: w.document, close: () => f.remove() };
  }
  async function until(fn, ms) { for (let i = 0; i < (ms || 4000) / 50; i++) { const v = fn(); if (v) return v; await sleep(50); } throw new Error('timeout waiting for UI state'); }
  const rv = (i, extra) => Object.assign({ reviewId: 'SF' + i, idDerived: false, text: i % 3 ? 'Âm thanh hay, đeo thoải mái ' + i : 'Pin yếu, sạc không vào ' + i, rating: i % 3 ? 5 : 2, date: null, verifiedPurchase: true, media: [], source: 'socialfetch' }, extra);
  const base = { provider: { name: 'socialfetch', label: 'Social Fetch', reportedTotalKind: 'product_total' }, product: { productId: '1729384756473829104', canonicalUrl: 'https://www.tiktok.com/shop/pdp/1729384756473829104' }, maxPages: 20 };
  function aiStub(body) {
    if (body.mode === 'report') return json(200, { ok: true, report: { product_category: '', positives: [], negatives: [], no_clear_negative: true, before_buying: [] } });
    if (body.mode === 'summary') return json(200, { ok: true, summary: { summary: 'Tóm tắt thử nghiệm (mock).', positives: ['Âm thanh'], negatives: ['Pin'], recurring_complaints: ['Pin'], quality_insights: [], before_buying: ['Kiểm tra bảo hành'] } });
    const ids = body.reviews.map(r => r.id);
    const neg = body.reviews.filter(r => /Pin/.test(r.text)).map(r => r.id);
    return json(200, { ok: true, analyzedIds: ids, findings: neg.length ? [{ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', rationale: 'Mock rationale', reviewIds: neg }] : [], sentiment: Object.fromEntries(ids.map(id => [id, neg.includes(id) ? 'negative' : 'positive'])) });
  }

  test('ui: full site has all 11 parts in order', async a => {
    const p = await openPage(1300, () => json(503, {}));
    try {
      const ids = [...p.d.querySelectorAll('main > section')].map(s => s.id);
      a.deepEqual(ids, ['home', 'problem', 'research', 'how', 'survey', 'features', 'demo', 'roadmap', 'evaluation', 'faq', 'cta']);
      a.ok(p.d.getElementById('dashboard'), 'analysis dashboard'); a.ok(p.d.querySelector('.site-footer .footer-sources'), 'footer sources');
      a.equal(p.d.querySelectorAll('#problem .feature').length, 5); a.equal(p.d.querySelectorAll('#survey .sv-card:not(.sv-takeaway)').length, 6); a.ok(p.d.querySelector('[data-i18n="sv.ch.t"]'), 'key challenges'); a.ok(p.d.querySelector('[data-i18n="sol.kicker"]'), 'proposed solution');
      a.equal(p.d.querySelectorAll('#features .feature').length, 4); a.equal(p.d.querySelectorAll('#roadmap .rm-card').length, 3);
      a.match(p.d.querySelector('[data-i18n="hero.cta2"]').getAttribute('data-go'), /^how$/);
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: every navigation link points to an existing section and opens it', async a => {
    const p = await openPage(1300, () => json(503, {}));
    try {
      const gos = [...new Set([...p.d.querySelectorAll('[data-go]')].map(e => e.dataset.go))];
      for (const g of gos) a.ok(g === 'home' || g === 'dashboard' || p.d.getElementById(g), 'missing target #' + g);
      for (const g of gos) {
        p.d.querySelector(`.site-header [data-go="${g}"], [data-go="${g}"]`).click();
        await sleep(30);
        if (g === 'dashboard') a.ok(!p.d.getElementById('dashboard').hidden && p.d.getElementById('landing').hidden, 'dashboard opens');
        else a.ok(!p.d.getElementById('landing').hidden, g + ' shows landing');
      }
      // nav fits in one row on a 1300px desktop
      a.ok(p.d.querySelector('.site-header').getBoundingClientRect().height < 90, 'header wraps');
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: every data-i18n key has a Vietnamese translation', async a => {
    const p = await openPage(1300, () => json(503, {}));
    try {
      const keys = [...new Set([...p.d.querySelectorAll('[data-i18n]')].map(e => e.dataset.i18n))];
      const VI = p.w.eval('VI'); const missing = keys.filter(k => !(k in VI));
      a.deepEqual(missing, [], 'untranslated keys');
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: survey percentages equal count / 61 (no hand-typed drift)', async a => {
    const p = await openPage(1300, () => json(503, {}));
    try {
      for (const card of p.d.querySelectorAll('#survey .sv-card:not(.sv-takeaway)')) {
        const k = Number(card.querySelector('.sv-n').textContent.split('/')[0]);
        const pct = card.querySelector('.ring span').textContent;
        a.equal(pct, (k / 61 * 100).toFixed(1) + '%', 'card ' + k);
        a.equal(card.querySelector('.ring').style.getPropertyValue('--p').trim(), (k / 61 * 100).toFixed(1));
      }
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: language toggle switches static and research text via the existing i18n', async a => {
    const p = await openPage(1200, () => json(503, {}));
    try {
      const enLead = p.d.querySelector('[data-i18n="research.lead"]').textContent;
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      a.equal(p.d.documentElement.lang, 'vi');
      a.match(p.d.querySelector('[data-i18n="research.lead"]').textContent, /Gen Z Việt Nam/);
      a.match(p.d.querySelector('[data-i18n="hero.note"]').textContent, /Không bao giờ dùng dữ liệu demo/);
      p.d.querySelector('.lang button[data-lang="en"]').click();
      a.equal(p.d.querySelector('[data-i18n="research.lead"]').textContent, enLead);
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: live flow shows real counts, resumes across calls, AI covers all reviews (mock API)', async a => {
    let call = 0;
    const p = await openPage(1200, (url, body) => {
      if (url === '/api/tiktok-review') {
        call++;
        if (call === 1) return json(200, { ...base, ok: true, reviews: Array.from({ length: 50 }, (_, i) => rv(i)), reportedTotal: 90, batch: { pagesFetched: 5, retrieved: 50, unique: 50, duplicates: 0 }, complete: false, stopReason: 'time_budget', resume: { provider: 'socialfetch', cursor: '6' } });
        a.equal(body.pagesSoFar, 5); a.equal(body.resume.cursor, '6');
        return json(200, { ...base, ok: true, reviews: Array.from({ length: 41 }, (_, i) => rv(49 + i)), reportedTotal: 90, batch: { pagesFetched: 4, retrieved: 41, unique: 41, duplicates: 0 }, complete: true, stopReason: 'exhausted', resume: null });
      }
      return aiStub(body);
    });
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/abc/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /AI đã phân tích toàn bộ 90/.test(p.d.getElementById('dash-main').textContent), 6000);
      const txt = p.d.getElementById('dash-main').textContent;
      a.match(txt, /Đã lấy 90\/90 đánh giá mà nguồn dữ liệu báo cáo\./);
      a.match(txt, /Đầy đủ/); a.match(txt, /nhà cung cấp dữ liệu xác nhận không còn trang/);
      a.match(txt, /Do AI tạo/); a.match(txt, /Nguyên văn review/); a.match(txt, /SF0/);
      a.match(txt, /Dữ liệu thật/);
      a.equal(call, 2, 'one resume call');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: partial retrieval (credits exhausted) keeps reviews and says why (mock API)', async a => {
    const p = await openPage(1200, (url, body) => url === '/api/tiktok-review'
      ? json(200, { ...base, ok: true, reviews: Array.from({ length: 30 }, (_, i) => rv(i)), reportedTotal: 120, batch: { pagesFetched: 3, retrieved: 30, unique: 30 }, complete: false, stopReason: 'credits_exhausted', resume: null })
      : aiStub(body));
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /AI đã phân tích toàn bộ 30/.test(p.d.getElementById('dash-main').textContent), 6000);
      const txt = p.d.getElementById('dash-main').textContent;
      a.match(txt, /Đã lấy 30\/120 đánh giá/); a.match(txt, /Chưa đầy đủ/); a.match(txt, /Nguồn dữ liệu đã đạt giới hạn truy xuất/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: zero reviews and provider-not-configured show honest empty states, no demo data (mock API)', async a => {
    const p = await openPage(1200, url => url === '/api/tiktok-review' ? json(503, { error: 'provider_not_configured', message: 'x' }) : json(500, {}));
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /Automatic review retrieval is not set up/.test(p.d.getElementById('dash-main').textContent));
      const txt = p.d.getElementById('dash-main').textContent;
      a.match(txt, /Reviews could not be retrieved/); a.ok(!/Demo dataset/.test(txt), 'no demo substitution');
    } finally { p.close(); }
    const q = await openPage(1200, url => json(200, { ...base, ok: true, reviews: [], reportedTotal: 0, batch: { pagesFetched: 1, retrieved: 0, unique: 0 }, complete: true, stopReason: 'exhausted', resume: null }));
    try {
      q.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      q.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /No reviews were retrieved/.test(q.d.getElementById('dash-main').textContent));
    } finally { q.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: AI not configured is surfaced; rule-based checks still shown (mock API)', async a => {
    const p = await openPage(1200, url => url === '/api/tiktok-review'
      ? json(200, { ...base, ok: true, reviews: Array.from({ length: 12 }, (_, i) => rv(i)), reportedTotal: 12, batch: { pagesFetched: 1, retrieved: 12, unique: 12 }, complete: true, stopReason: 'exhausted', resume: null })
      : json(503, { error: 'ai_not_configured' }));
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /AI analysis is not set up on this server\. Site owner: add GEMINI_API_KEY/.test(p.d.getElementById('dash-main').textContent));
      a.match(p.d.getElementById('dash-main').textContent, /Rule-based checks/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: pasted reviews run all six steps end to end (mock API)', async a => {
    const calls = [];
    const p = await openPage(1200, (url, body) => { calls.push(body.mode); if (body.mode === 'summary') { a.equal(body.stance, 'mixed'); a.equal(body.counts.negative, 4); }
      return body.mode === 'summary' ? json(200, { ok: true, summary: { summary: 'MOCK', positives: [], negatives: [], recurring_complaints: [], quality_insights: [], before_buying: ['MOCK check'], decision_rationale: 'MOCK rationale' } }) : aiStub(body); });
    try {
      p.d.querySelector('[data-go="dashboard"]').click();
      p.d.getElementById('dash-reviews').value = Array.from({ length: 12 }, (_, i) => i % 3 ? `5★ Âm thanh hay số ${i}` : `2★ Pin yếu số ${i}`).join('\n');
      p.w.eval("state.source = { type: 'manual' }");
      p.d.querySelector('#dash-form button[type=submit]').click();
      await until(() => p.d.querySelector('.decision-panel'), 5000);
      const txt = p.d.getElementById('dash-main').textContent;
      a.equal(p.d.querySelectorAll('.wf-step').length, 6); a.equal(p.d.querySelectorAll('.wf-done').length, 6, 'all six steps done');
      a.match(txt, /Mixed evidence/); a.match(txt, /8 positive|66\.7% positive/); a.match(txt, /Certainty: low/); a.match(txt, /Credibility signals/); a.match(txt, /8 of 12 classified reviews share/);
      a.ok(p.d.querySelectorAll('.wf-st').length === 6 && [...p.d.querySelectorAll('.wf-st')].every(e => e.textContent === 'Done'), 'step labels say Done'); a.match(txt, /MOCK rationale/); a.match(txt, /Sentiment by Gemini/);
      a.deepEqual(calls, ['batch', 'summary', 'report']);
      const report = p.w.eval('reportText()');
      a.match(report, /Sentiment by Gemini: Positive 8, Neutral 0, Negative 4/); a.match(report, /Pin yếu số 0/); a.match(report, /Mixed evidence/); a.match(report, /Completeness & limitations/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: demo products stay offline (no API calls) and are labelled demo', async a => {
    const calls = [];
    const p = await openPage(1200, url => { calls.push(url); return json(500, {}); });
    try {
      p.d.querySelector('#demo-row [data-demo="headphones"]').click();
      await sleep(300);
      a.deepEqual(calls.filter(u => u !== '/api/health'), [], 'demo must not call the API');
      a.ok(!p.d.querySelector('.wf'), 'no live workflow for demo'); a.match(p.d.getElementById('dash-main').textContent, /Demo/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: page served without the API backend says so (not "provider returned an error")', async a => {
    const p = await openPage(1200, () => new Response('<!DOCTYPE HTML><html>Unsupported method</html>', { status: 501, headers: { 'Content-Type': 'text/html' } }));
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/tai-nghe/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /Không có API lấy review tại địa chỉ này \(HTTP 501\)/.test(p.d.getElementById('dash-main').textContent));
      const txt = p.d.getElementById('dash-main').textContent;
      a.ok(!/Nhà cung cấp trả về lỗi/.test(txt), 'must not blame the provider');
      a.match(p.d.querySelectorAll('.wf-step')[1].textContent, /Thất bại/);
      a.ok(!p.d.getElementById('live-retry'), 'no pointless retry'); a.ok(p.d.getElementById('live-paste'), 'manual fallback offered');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: platform timeout and bad link give specific messages and the right buttons', async a => {
    const p = await openPage(1200, () => new Response('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT', { status: 504 }));
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /timed out before the server answered \(HTTP 504\)/.test(p.d.getElementById('dash-main').textContent));
      a.ok(p.d.getElementById('live-retry'), 'retry offered for timeouts');
    } finally { p.close(); }
    const q = await openPage(1200, () => json(400, { error: 'invalid_url', stopReason: 'invalid_url', retryable: false, code: 'no_product_id', message: 'x' }));
    try {
      q.d.getElementById('hero-url').value = 'https://www.tiktok.com/@shop/video/7300000000000000000';
      q.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /No TikTok Shop product ID was found in this link/.test(q.d.getElementById('dash-main').textContent));
      a.ok(q.d.getElementById('live-editlink'), 'fix-link button'); a.ok(!q.d.getElementById('live-retry'));
    } finally { q.close(); }
  }, { browserOnly: true, mock: true });

  test('ui: after failed retrieval, pasting reviews continues into the Gemini steps (mock API)', async a => {
    const p = await openPage(1200, (url, body) => url === '/api/tiktok-review' ? json(502, { error: 'lookup_failed', stopReason: 'lookup_failed', retryable: true, diagnostic: { httpStatus: 502, providerCode: 'lookup_failed' }, reviews: [], complete: false }) : aiStub(body));
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => p.d.getElementById('live-paste'));
      a.match(p.d.getElementById('dash-main').textContent, /could not look up this product right now/); a.match(p.d.getElementById('dash-main').textContent, /lookup_failed/);
      p.d.getElementById('live-paste').click();
      p.d.getElementById('dash-reviews').value = Array.from({ length: 10 }, (_, i) => i % 2 ? `5★ Âm thanh hay ${i}` : `1★ Pin yếu ${i}`).join('\n');
      p.d.querySelector('#dash-form button[type=submit]').click();
      await until(() => p.d.querySelector('.decision-panel'), 5000);
      a.equal(p.d.querySelectorAll('.wf-done').length, 6); a.match(p.d.getElementById('dash-main').textContent, /10 reviews you provided/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  // Mocked /api/analyze for report scenarios: findings from keyword groups, report built from the findings.
  function scenarioStub(posRe, negRe) {
    return (url, body) => {
      if (body.mode === 'summary') return json(200, { ok: true, summary: { summary: 'MOCK', positives: [], negatives: [], recurring_complaints: [], quality_insights: [], before_buying: [], decision_rationale: 'MOCK' } });
      if (body.mode === 'report') {
        const pos = [], neg = [];
        body.findings.forEach((f, i) => (f.kind === 'positive' ? pos : neg).push({ heading: 'MOCK ' + f.title, explanation: 'MOCK giải thích', impact: f.kind === 'positive' ? '' : 'MOCK ảnh hưởng', finding_refs: [i], review_ids: f.reviewIds.slice(0, 2), support: f.count }));
        return json(200, { ok: true, report: { product_category: 'tai nghe', positives: pos, negatives: neg, no_clear_negative: !neg.length, before_buying: ['MOCK: kiểm tra chính sách đổi trả'] } });
      }
      const ids = body.reviews.map(r => r.id);
      const p = body.reviews.filter(r => posRe && posRe.test(r.text)).map(r => r.id), n = body.reviews.filter(r => negRe && negRe.test(r.text)).map(r => r.id);
      const findings = [];
      if (p.length) findings.push({ kind: 'positive', category: 'performance', title: 'Âm thanh rõ', rationale: 'MOCK', reviewIds: p });
      if (n.length) findings.push({ kind: 'negative', category: 'battery_charging', title: 'Pin yếu', rationale: 'MOCK', reviewIds: n });
      return json(200, { ok: true, analyzedIds: ids, findings, sentiment: Object.fromEntries(ids.map(id => [id, n.includes(id) ? 'negative' : p.includes(id) ? 'positive' : 'neutral'])) });
    };
  }
  async function runManual(p, lines) {
    p.d.querySelector('[data-go="dashboard"]').click();
    p.d.getElementById('dash-reviews').value = lines.join('\n');
    p.w.eval("state.source = { type: 'manual' }");
    p.d.querySelector('#dash-form button[type=submit]').click();
  }
  const reportText = p => (p.d.getElementById('vi-report') || p.d.querySelector('.report-panel') || { textContent: '' }).textContent;

  test('report UI 1: mostly positive -> positives with quotes + IDs, explicit "no clear negative"', async a => {
    const p = await openPage(1200, scenarioStub(/hay/, null));
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      await runManual(p, Array.from({ length: 12 }, (_, i) => `5★ Âm thanh hay lắm ${i}`));
      await until(() => /Lưu ý trước khi mua/.test(reportText(p)), 5000);
      const txt = reportText(p);
      a.match(txt, /Dữ liệu chi tiết về các đánh giá \(feedback\) của người mua đối với sản phẩm Chưa xác định tên sản phẩm nhìn chung tập trung vào các điểm chính sau:/);
      a.match(txt, /👍 Các điểm được đánh giá cao/); a.match(txt, /“Âm thanh hay lắm 0”/); a.match(txt, /USR-001/);
      a.match(txt, /lặp lại · 12 đánh giá/); a.match(txt, /không có phản hồi tiêu cực rõ ràng/); a.match(txt, /Đã phân tích 12\/12 đánh giá/); a.match(txt, /Đánh giá bạn đã dán/);
      a.match(txt, /Chỉ có 12 đánh giá được phân tích/, 'small-sample warning');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('report UI 2: mixed -> separate positive and negative sections; isolated complaint labelled', async a => {
    const p = await openPage(1200, scenarioStub(/hay/, /Pin/));
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      await runManual(p, [...Array.from({ length: 10 }, (_, i) => `5★ Âm thanh hay ${i}`), '2★ Pin yếu quá']);
      await until(() => /Lưu ý trước khi mua/.test(reportText(p)), 5000);
      const txt = reportText(p);
      a.match(txt, /MOCK Âm thanh rõ/); a.match(txt, /MOCK Pin yếu/); a.match(txt, /trường hợp riêng lẻ · 1 đánh giá/); a.match(txt, /“Pin yếu quá”/); a.match(txt, /Ảnh hưởng/);
      a.ok(txt.indexOf('👍') < txt.indexOf('👎') && txt.indexOf('👎') < txt.indexOf('📝'), 'section order');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('report UI 3: mostly negative -> negatives, and "no clear positive" stated', async a => {
    const p = await openPage(1200, scenarioStub(null, /Pin|hỏng/));
    try {
      await runManual(p, Array.from({ length: 11 }, (_, i) => `1★ Pin hỏng sau ${i} ngày`));
      await until(() => /Before you buy/.test(reportText(p)), 5000);
      const txt = reportText(p);
      a.match(txt, /do not clearly support any positive theme/); a.match(txt, /recurring · 11 reviews/); a.match(txt, /Points to note/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('report UI 4: insufficient information -> honest "not enough information", no invented themes', async a => {
    const p = await openPage(1200, scenarioStub(null, null));
    try {
      await runManual(p, ['ok', 'được', '3★ bình thường']);
      await until(() => /Not enough information for a detailed report/.test(reportText(p)), 5000);
      a.ok(!/👍/.test(reportText(p))); a.match(p.d.querySelectorAll('.wf-step')[4].textContent, /Not enough recurring points/);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('report UI 5+6: retrieval fails -> paste -> report; report error shows retry; AI missing shows reason', async a => {
    let failReport = true;
    const base = scenarioStub(/hay/, /Pin/);
    const p = await openPage(1200, (url, body) => url === '/api/tiktok-review' ? json(503, { error: 'provider_not_configured', stopReason: 'provider_not_configured', retryable: false, reviews: [] })
      : body.mode === 'report' && failReport ? json(502, { error: 'ai_failed', upstream: { http: 500 } }) : base(url, body));
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => p.d.getElementById('live-paste'));
      p.d.getElementById('live-paste').click();
      p.d.getElementById('dash-reviews').value = Array.from({ length: 10 }, (_, i) => i % 2 ? `5★ Âm thanh hay ${i}` : `2★ Pin yếu ${i}`).join('\n');
      p.d.querySelector('#dash-form button[type=submit]').click();
      await until(() => /could not be generated: Gemini returned an error/.test(reportText(p)), 5000);
      a.ok(p.d.getElementById('rp-retry')); a.match(p.d.querySelectorAll('.wf-step')[4].textContent, /Detailed report failed/);
      failReport = false; p.d.getElementById('rp-retry').click();
      await until(() => /Before you buy/.test(reportText(p)), 5000);
      a.match(reportText(p), /Reviews you pasted/);
    } finally { p.close(); }
    const q = await openPage(1200, () => json(503, { error: 'ai_not_configured' }));
    try {
      await runManual(q, Array.from({ length: 10 }, (_, i) => `5★ Tốt ${i}`));
      await until(() => /needs the Gemini analysis, which did not run/.test(reportText(q)), 5000);
    } finally { q.close(); }
  }, { browserOnly: true, mock: true });

  test('report UI 7: VI/EN toggle switches headings; AI text flagged and regenerable; copy text structured', async a => {
    const p = await openPage(1200, scenarioStub(/hay/, /Pin/));
    try {
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      await runManual(p, [...Array.from({ length: 10 }, (_, i) => `5★ Âm thanh hay ${i}`), '2★ Pin yếu', '2★ Pin yếu nữa']);
      await until(() => /Lưu ý trước khi mua/.test(reportText(p)), 5000);
      p.d.querySelector('.lang button[data-lang="en"]').click();
      const txt = reportText(p);
      a.match(txt, /Highly rated points \(positive feedback\)/); a.match(txt, /written in the other language/); a.ok(p.d.getElementById('rp-retry'), 'regenerate offered');
      const plain = p.w.eval("TL_live.run && document.getElementById('rp-copy') ? true : false");
      a.ok(plain, 'copy button present');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('motion: reveals on scroll, count-up ends on the exact verified figures, nav marks the active section', async a => {
    // IntersectionObserver measures iframes against the top-level viewport, so the frame must fit the test page.
    const p = await openPage(Math.min(400, innerWidth - 40), () => json(503, {}));
    try {
      a.ok(p.d.documentElement.classList.contains('motion'), 'motion enabled');
      const cards = [...p.d.querySelectorAll('#survey .sv-card:not(.sv-takeaway)')];
      const before = cards.map(c => c.querySelector('.ring span').textContent);
      a.ok(cards.every(c => c.classList.contains('rv') && !c.classList.contains('in')), 'survey hidden until reached');
      a.ok([...p.d.querySelectorAll('#how .step')].every(s => !s.classList.contains('in')), 'workflow steps wait until reached');
      cards[0].scrollIntoView({ block: 'center', behavior: 'instant' });
      await until(() => cards[0].classList.contains('in'), 3000);
      await sleep(1700);
      a.deepEqual(cards.map(c => c.querySelector('.ring span').textContent), before, 'final text identical to verified figures');
      a.deepEqual(cards.map(c => c.querySelector('.ring').style.getPropertyValue('--p').trim()), before.map(x => x.replace('%', '')));
      p.d.getElementById('survey').scrollIntoView({ block: 'start', behavior: 'instant' });
      await until(() => p.d.querySelector('.nav a[data-go="survey"]').classList.contains('is-active'), 2000);
      a.equal(p.d.querySelectorAll('.nav a.is-active').length, 1);
      p.d.getElementById('how').scrollIntoView({ block: 'start' });
      const steps = [...p.d.querySelectorAll('#how .step')];
      await until(() => steps[0].classList.contains('in'), 3000);
      for (const st of steps) { st.scrollIntoView({ block: 'center', behavior: 'instant' }); await until(() => st.classList.contains('in'), 2000); }
      a.deepEqual(steps.map(s => s.style.getPropertyValue('--rv-d')), ['0s', '0.14s', '0.28s', '0.42s', '0.56s', '0.7s'], 'steps play in sequence');
      a.ok(!p.d.querySelector('#dashboard .rv'), 'dashboard content is never hidden by reveal');
    } finally { p.close(); }
  }, { browserOnly: true });

  test('motion: content is visible without the motion class, and reduced-motion overrides exist', async a => {
    const p = await openPage(1200, () => json(503, {}));
    try {
      p.d.documentElement.classList.remove('motion');
      const el = p.d.querySelector('#survey .sv-card');
      a.equal(p.w.getComputedStyle(el).opacity, '1');
      const css = [...p.d.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch (e) { return []; } }).map(r => r.cssText).join('\n');
      a.match(css, /prefers-reduced-motion: reduce[\s\S]*\.rv \{ opacity: 1 !important/);
      a.match(css, /prefers-reduced-motion: no-preference[\s\S]*html\.motion \.rv/);
    } finally { p.close(); }
  }, { browserOnly: true });

  test('motion: analyse buttons show a loading state during a run and recover after (mock API)', async a => {
    let release; const gate = new Promise(r => { release = r; });
    const p = await openPage(1200, async url => { await gate; return json(503, { error: 'provider_not_configured', stopReason: 'provider_not_configured', retryable: false, reviews: [] }); });
    try {
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await sleep(100);
      const btn = p.d.querySelector('#dash-form [type=submit]');
      a.equal(btn.getAttribute('aria-busy'), 'true'); a.ok(btn.disabled);
      release();
      await until(() => !btn.hasAttribute('aria-busy'), 3000);
      a.ok(!btn.disabled);
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });

  test('hero: collage hero content, translated artwork alt, four tiles, and the liquid artwork starts or falls back', async a => {
    const p = await openPage(Math.min(400, innerWidth - 40), () => json(503, {}));
    try {
      const img = p.d.querySelector('.hero-art-img');
      a.ok(img && img.complete && img.naturalWidth === 640, 'artwork image loads');
      a.equal(p.d.querySelectorAll('.hero-tiles li').length, 4);
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      a.match(img.getAttribute('alt'), /Minh hoạ: trang sản phẩm TikTok Shop/);
      a.deepEqual([...p.d.querySelectorAll('.hero-tiles b')].map(b => b.textContent), ['Review thật', 'Phân tích bằng AI', 'Thông tin chính', 'Mua sắm thông minh']);
      a.match(p.d.querySelector('[data-i18n="hero.analyse"]').textContent, /Phân tích ngay/);
      p.d.querySelector('.lang button[data-lang="en"]').click();
      a.match(img.getAttribute('alt'), /^Illustration: a TikTok Shop product page/);
      a.deepEqual([...p.d.querySelectorAll('.hero-tiles b')].map(b => b.textContent), ['Real Reviews', 'AI-Powered Analysis', 'Key Insights', 'Shop Smarter']);
      const hero = p.d.getElementById('home');
      await until(() => ['on', 'off'].includes(hero.dataset.gl), 8000);
      if (hero.dataset.gl === 'on') { a.ok(hero.querySelector('.hero-canvas'), 'canvas mounted'); await until(() => p.w.getComputedStyle(img).opacity === '0', 2000); a.ok(p.w.TL_liquidHero.instance.engine.n > 1000, 'particles built'); }
      else a.equal(p.w.getComputedStyle(img).opacity, '1', 'static image shown when WebGL is unavailable');
    } finally { p.close(); }
  }, { browserOnly: true });

  test('hero: without WebGL2 or with reduced motion the static artwork stays and no canvas is left behind', async a => {
    const p = await openPage(Math.min(400, innerWidth - 40), () => json(503, {}));
    try {
      const mk = () => { const h = p.d.createElement('section'); h.innerHTML = '<div class="hero-art"><img class="hero-art-img" src="hero-art.jpg"></div>'; p.d.body.appendChild(h); return h; };
      const proto = p.w.HTMLCanvasElement.prototype, orig = proto.getContext;
      proto.getContext = function (type) { return type === 'webgl2' ? null : orig.apply(this, arguments); };
      let h = mk();
      try { a.equal(p.w.TL_liquidHero.mount({ hero: h, art: h.querySelector('.hero-art'), img: h.querySelector('img') }), null); }
      finally { proto.getContext = orig; }
      a.equal(h.dataset.gl, 'off'); a.ok(!h.querySelector('canvas'));
      const mm = p.w.matchMedia;
      p.w.matchMedia = q => /reduce/.test(q) ? { matches: true, addEventListener() {} } : mm.call(p.w, q);
      h = mk();
      try { a.equal(p.w.TL_liquidHero.mount({ hero: h, art: h.querySelector('.hero-art'), img: h.querySelector('img') }), null); }
      finally { p.w.matchMedia = mm; }
      a.equal(h.dataset.gl, 'reduced'); a.ok(!h.querySelector('canvas'));
    } finally { p.close(); }
  }, { browserOnly: true });

  test('ui: no horizontal overflow at 360px (landing, research, live dashboard)', async a => {
    const p = await openPage(360, (url, body) => url === '/api/tiktok-review'
      ? json(200, { ...base, ok: true, reviews: Array.from({ length: 20 }, (_, i) => rv(i, { reviewId: 'VERY-LONG-REVIEW-IDENTIFIER-' + i + '-ABCDEFGHIJKLMNOP' })), reportedTotal: 20, batch: { pagesFetched: 1, retrieved: 20, unique: 20 }, complete: true, stopReason: 'exhausted', resume: null })
      : aiStub(body));
    try {
      const over = () => p.d.documentElement.scrollWidth - p.w.innerWidth;
      a.ok(over() <= 0, 'landing overflow ' + over() + 'px');
      p.d.querySelector('.lang button[data-lang="vi"]').click();
      a.ok(over() <= 0, 'landing VI overflow ' + over() + 'px');
      p.d.getElementById('hero-url').value = 'https://www.tiktok.com/shop/pdp/1729384756473829104';
      p.d.querySelector('#hero-url-form button[type=submit]').click();
      await until(() => /AI đã phân tích toàn bộ/.test(p.d.getElementById('dash-main').textContent), 6000);
      a.ok(over() <= 0, 'dashboard overflow ' + over() + 'px');
      const wide = [...p.d.querySelectorAll('#dash-main *')].filter(el => el.getBoundingClientRect().right > p.w.innerWidth + 1).map(el => el.className || el.tagName).slice(0, 5);
      a.deepEqual(wide, [], 'elements wider than viewport');
    } finally { p.close(); }
  }, { browserOnly: true, mock: true });
})();
