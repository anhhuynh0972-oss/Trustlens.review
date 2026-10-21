// Live TikTok Shop retrieval, batched Gemini analysis and evidence rendering.
// Builds on the page's globals (state, t, esc, analyse, renderMain, panels…) defined in index.html.
(function () {
  'use strict';
  const A = TL_analysis, R = TL_retrieve;
  const AI_CONCURRENCY = 2;
  const MAX_CLIENT_CALLS = 60; // loop guard for resume calls
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => n == null ? t('vNA') : Number(n).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');

  // One analysis run drives the six-step workflow for both product links (kind 'link') and
  // pasted/imported reviews (kind 'manual'). Demo products stay offline and rule-based.
  function newRun(url, kind) {
    return {
      url, kind: kind || 'link', phase: 'retrieving', product: null, provider: null, reportedTotal: null, productSummary: null,
      reviews: [], seen: new Set(), pages: 0, retrieved: 0, duplicates: 0, skipped: 0,
      complete: false, stopReason: null, resume: null, maxPages: null, errorCode: null,
      controller: new AbortController(), cancelled: false,
      ai: { status: 'idle', analyzedIds: new Set(), results: [], failedIds: new Set(), failedBatches: 0, batchesTotal: 0, batchesDone: 0, merged: null, summary: null, error: null }
    };
  }
  let run = null;

  // ---------- Retrieval ----------
  // Loading state on the analyse buttons while a run is in progress (prevents double submits).
  function setBusy(on) {
    $$('#hero-url-form [type=submit], #dash-form [type=submit], #hero-manual [type=submit]').forEach(b => {
      if (on) { b.setAttribute('aria-busy', 'true'); b.disabled = true; } else { b.removeAttribute('aria-busy'); b.disabled = false; }
    });
  }

  async function start(url) {
    if (run) { run.cancelled = true; run.controller.abort(); }
    run = newRun(url, 'link');
    if (state.detailsFromDemo) { setDetails({}); state.detailsFromDemo = false; }
    state.live = run; state.source = { type: 'live' }; state.url = url; state.result = null; state.notice = null; state.filter = 'all';
    state.details = readDetails();
    renderMain();
    const main = $('#dash-main');
    if (main.getBoundingClientRect().top > innerHeight * 0.6) main.scrollIntoView({ block: 'start' });
    const mine = run;
    setBusy(true);
    try {
      await retrieve(mine);
      if (mine !== state.live) return;
      await afterRetrieval(mine);
    } finally { if (mine === run) setBusy(false); }
  }

  async function retrieve(r) {
    r.phase = 'retrieving';
    for (let calls = 0; calls < MAX_CLIENT_CALLS; calls++) {
      if (r.cancelled) { r.stopReason = 'cancelled'; break; }
      let res, data = {}, isApiJson = false;
      try {
        res = await fetch('/api/tiktok-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: r.url, resume: r.resume, pagesSoFar: r.pages }), signal: r.controller.signal });
        const text = await res.text();
        try { data = JSON.parse(text); isApiJson = !!data && typeof data === 'object' && !Array.isArray(data); } catch (e) { data = {}; }
      } catch (e) {
        r.stopReason = r.cancelled ? 'cancelled' : 'network'; r.retryable = true; break;
      }
      r.httpStatus = res.status;
      if (!isApiJson) {
        // Not an answer from the TrustLens API (and so not from the provider): e.g. the page is served
        // without the /api backend (404/405/501), the function crashed (500) or the platform timed out (504).
        r.stopReason = r.errorCode = [404, 405, 501].includes(res.status) ? 'api_unavailable' : res.status === 504 ? 'gateway_timeout' : res.status >= 500 ? 'server_error' : 'bad_api_response';
        r.retryable = r.stopReason !== 'api_unavailable';
        break;
      }
      if (data.diagnostic) r.diagnostic = data.diagnostic;
      if (typeof data.retryable === 'boolean') r.retryable = data.retryable;
      if (data.error === 'invalid_url') r.urlCode = data.code;
      if (data.product) r.product = data.product;
      if (data.provider) r.provider = data.provider;
      if (data.maxPages) r.maxPages = data.maxPages;
      if (res.status === 202 && data.pending) { r.resume = data.resume; r.stopReason = 'provider_processing'; paint(); await wait(3000); continue; }
      const incoming = Array.isArray(data.reviews) ? data.reviews : [];
      if (!res.ok && !incoming.length) {
        r.errorCode = data.error || 'upstream_error';
        r.stopReason = data.stopReason || data.error || 'upstream_error';
        if (data.code) r.errorDetail = data.code;
        break;
      }
      const d = R.dedupe(incoming, r.seen);
      r.reviews.push(...d.unique);
      const b = data.batch || {};
      r.pages += b.pagesFetched || 0; r.retrieved += b.retrieved || 0; r.skipped += b.skippedEmpty || 0;
      r.duplicates += (b.duplicates || 0) + d.duplicates;
      if (data.reportedTotal != null) r.reportedTotal = data.reportedTotal;
      if (data.productSummary) r.productSummary = data.productSummary;
      r.complete = data.complete === true; r.stopReason = data.stopReason; r.resume = data.resume || null;
      paint();
      if (r.complete || !(data.stopReason === 'time_budget' && r.resume)) break; // other stops wait for the user
    }
    r.phase = 'retrieved';
  }

  const isRunView = () => state.live && ((state.source.type === 'live' && state.live.kind === 'link') || (state.source.type === 'manual' && state.live.kind === 'manual'));

  async function afterRetrieval(r) {
    if (r !== state.live || !isRunView()) return;
    if (!r.reviews.length) { r.phase = 'done'; paint(); return; }
    rebuildResult(r);
    paint();
    if (!r.cancelled) await runAI(r);
  }

  function rebuildResult(r) {
    state.result = analyse(r.reviews.map(x => ({ id: x.reviewId, rating: x.rating != null ? Math.min(5, Math.max(1, Math.round(x.rating))) : null, text: x.text })));
    state.at = new Date();
  }

  async function continueRetrieval() {
    const r = run; if (!r) return;
    r.cancelled = false; r.controller = new AbortController();
    await retrieve(r);
    if (r !== state.live) return;
    await afterRetrieval(r);
  }

  function cancel() {
    if (!run) return;
    setBusy(false);
    run.cancelled = true; run.controller.abort();
    if (run.phase === 'retrieving') run.stopReason = 'cancelled';
    paint();
  }

  // ---------- AI analysis: every review is sent in some batch; failures are reported, never hidden ----------
  async function postJson(url, body, signal) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function runAI(r, reviews) {
    reviews = reviews || r.reviews;
    const ai = r.ai;
    const todo = reviews.filter(x => !ai.analyzedIds.has(x.reviewId));
    if (!todo.length && ai.merged) return;
    const batches = A.makeBatches(todo, { maxCount: 80, maxChars: 40000 });
    ai.status = 'running'; ai.error = null; ai.failedIds = new Set(); ai.failedBatches = 0;
    ai.batchesTotal = batches.length; ai.batchesDone = 0;
    paint();
    let notConfigured = false, lastErr = null;
    const queue = batches.slice();
    const worker = async () => {
      while (queue.length && !r.cancelled && !notConfigured) {
        const batch = queue.shift();
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok && !r.cancelled; attempt++) {
          try {
            const { res, data } = await postJson('/api/analyze', { mode: 'batch', language: lang, reviews: batch.map(x => ({ id: x.reviewId, text: x.text, rating: x.rating })) }, r.controller.signal);
            if (res.status === 503 && data.error === 'ai_not_configured') { notConfigured = true; break; }
            if (res.ok && Array.isArray(data.findings)) {
              ai.results.push({ findings: data.findings, sentiment: data.sentiment || {} });
              (data.analyzedIds || []).forEach(id => ai.analyzedIds.add(id));
              ok = true;
            } else { lastErr = data.error || ('HTTP ' + res.status); if (data.error === 'ai_auth' || data.error === 'ai_model_unavailable') { notConfigured = false; ai.fatal = data.error; queue.length = 0; break; } if (res.status === 429 || res.status >= 500) await wait(2500 * (attempt + 1)); }
          } catch (e) { lastErr = r.cancelled ? 'cancelled' : 'network'; }
        }
        if (!ok) { ai.failedBatches++; batch.forEach(x => ai.failedIds.add(x.reviewId)); }
        ai.batchesDone++;
        paint();
      }
    };
    await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, batches.length) }, worker));
    if (notConfigured) { ai.status = 'not_configured'; paint(); return; }
    if (!ai.analyzedIds.size) { ai.status = 'failed'; ai.error = lastErr || 'unknown'; paint(); return; }
    ai.merged = A.mergeBatchResults(ai.results, r.reviews.filter(x => ai.analyzedIds.has(x.reviewId)));
    ai.decision = A.decisionBasis(ai.merged, r.reviews, { retrieved: r.reviews.length, complete: r.complete, sellerData: hasSellerData(r) });
    ai.status = 'summarising'; paint();
    if (!r.cancelled) {
      try {
        const d = ai.decision;
        const { res, data } = await postJson('/api/analyze', { mode: 'summary', language: lang, analyzed: ai.analyzedIds.size, retrieved: r.reviews.length, stance: d.stance, counts: d.counts, unknowns: d.unknowns, findings: ai.merged.findings.map(f => ({ kind: f.kind, category: f.category, title: f.title, count: f.count })) }, r.controller.signal);
        ai.summary = res.ok ? data.summary : null;
        if (!res.ok) ai.error = data.message || data.error;
      } catch (e) { ai.error = 'network'; }
    }
    ai.summaryLang = lang;
    ai.status = ai.failedBatches || ai.analyzedIds.size < r.reviews.length ? 'partial' : 'done';
    ai.at = new Date();
    r.phase = 'done';
    paint();
    await generateReport(r);
  }

  // ---------- Step 5: structured buyer report (Gemini writes, TrustLens validates and quotes) ----------
  async function generateReport(r) {
    const ai = r.ai, m = ai.merged;
    if (!m) return;
    if (!m.findings.length) { ai.reportStatus = 'insufficient'; paint(); return; }
    ai.reportStatus = 'running'; ai.reportError = null; paint();
    try {
      const { res, data } = await postJson('/api/analyze', { mode: 'report', language: lang, productName: productName(r).known ? productName(r).name : '', analyzed: ai.analyzedIds.size, retrieved: r.reviews.length,
        findings: m.findings.map(f => ({ kind: f.kind, category: f.category, title: f.title, count: f.count, reviewIds: f.reviewIds, excerpts: f.excerpts })) }, r.controller.signal);
      if (res.ok && data.report) { ai.report = data.report; ai.reportLang = lang; ai.reportStatus = 'done'; }
      else { ai.reportStatus = 'error'; ai.reportError = data.error || ('HTTP ' + res.status); }
    } catch (e) { ai.reportStatus = 'error'; ai.reportError = r.cancelled ? 'cancelled' : 'network'; }
    paint();
  }

  function productName(r) {
    const d = state.details || {};
    if (r.kind === 'manual' && d.product && !state.detailsFromDemo) return { known: true, name: d.product, byUser: true };
    if (r.product && r.product.name) return { known: true, name: r.product.name };
    return { known: false, name: t('rpNoName') };
  }

  // ---------- Rendering ----------
  function paint() { if (!$('#dashboard').hidden) renderMain(); }

  function reasonText(r) {
    if ((r.stopReason || r.errorCode) === 'invalid_url' && r.urlCode && STR.en['url_' + r.urlCode]) return t('url_' + r.urlCode);
    const key = 'r_' + (r.stopReason || r.errorCode || 'upstream_error');
    return STR.en[key] ? t(key, { n: r.maxPages || '?', s: r.httpStatus || '?' }) : t('r_upstream_error');
  }

  function hasSellerData(r) {
    const d = state.details || {};
    return r.kind === 'manual' && !!(d.shop || d.rating || d.sold || d.since || d.response);
  }

  function manualStatusPanel(r) {
    const src = state.imported && state.imported.reviews === r.reviews ? t('srcImported', { f: state.imported.name }) : t('srcPasted');
    return `<div class="panel span-6 live-status"><div class="panel-head"><h2>${t('manualT', { n: fmt(r.reviews.length) })}</h2><span class="pill pill-soft">${t('manualTag')}</span></div>
      <div class="source-bar"><span><b>${t('sourceLbl')}:</b> ${esc(src)}</span><span>${t('manualNote')}</span></div></div>`;
  }

  function statusPanel(r) {
    if (r.kind === 'manual') return manualStatusPanel(r);
    const running = r.phase === 'retrieving';
    const unique = r.reviews.length;
    const total = r.reportedTotal;
    const pctDone = total ? Math.min(100, Math.round(unique / total * 100)) : null;
    const providerLabel = r.provider ? r.provider.label : '…';
    const headline = running ? (r.stopReason === 'provider_processing' ? t('stProcessing') : t('stLoading'))
      : r.complete ? t('stDone') : (unique ? t('stPartial') : t('failT'));
    const countLine = total != null
      ? (r.provider && r.provider.reportedTotalKind === 'provider_collected' ? t('gotXofYCollected', { x: fmt(unique), y: fmt(total) }) : t('gotXofY', { x: fmt(unique), y: fmt(total) }))
      : t('gotX', { x: fmt(unique) });
    const aiCount = r.ai.analyzedIds.size;
    const stat = (k, v) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
    const buttons = [];
    if (running || r.ai.status === 'running' || r.ai.status === 'summarising') buttons.push(`<button class="btn btn-ghost btn-sm" type="button" id="live-cancel">${t('cancel')}</button>`);
    if (!running && r.resume && !r.complete && r.stopReason !== 'page_cap') buttons.push(`<button class="btn btn-primary btn-sm" type="button" id="live-continue">${t(r.stopReason === 'cancelled' ? 'cont' : 'retry')}</button>`);
    if (!running && !unique && !r.resume && r.retryable !== false) buttons.push(`<button class="btn btn-primary btn-sm" type="button" id="live-retry">${t('retry')}</button>`);
    if (!running && !unique && r.stopReason === 'invalid_url') buttons.push(`<button class="btn btn-primary btn-sm" type="button" id="live-editlink">${t('editLink')}</button>`);
    if (!running && !unique) buttons.push(`<button class="btn btn-ghost btn-sm" type="button" id="live-paste">${t('pasteInstead')}</button>`);
    return `<div class="panel span-6 live-status" aria-live="polite">
      <div class="panel-head"><h2>${esc(headline)}</h2><span class="pill pill-live">${t('liveTag')}</span></div>
      <p class="live-line">${running ? '<span class="spin" aria-hidden="true"></span>' : ''}${esc(countLine)}</p>
      ${pctDone != null ? `<div class="bar bar-lg" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pctDone}" aria-label="${esc(countLine)}"><span class="p" style="width:${pctDone}%"></span></div>` : ''}
      <div class="stat-row live-stats">
        ${stat(t('kReported'), fmt(total))}${stat(t('kRetrieved'), fmt(r.retrieved))}${stat(t('kUnique'), fmt(unique))}${stat(t('kPages'), fmt(r.pages))}${stat(t('kAnalyzed'), `${fmt(aiCount)}/${fmt(unique)}`)}
      </div>
      <div class="source-bar">
        <span><b>${t('kProduct')}:</b> ${r.product ? esc(r.product.productId) : '…'}</span>
        <span><b>${t('kStatus')}:</b> ${running ? t('vRunning') : r.complete ? t('vComplete') : unique ? t('vPartial') : t('vFailed')}</span>
        ${!running && r.stopReason ? `<span><b>${t('reason')}:</b> ${esc(reasonText(r))}</span>` : ''}
        ${!running && !r.complete && (r.httpStatus >= 400 || (r.diagnostic && r.diagnostic.providerCode)) ? `<span class="diag"><b>${t('diagLbl')}:</b> ${r.httpStatus ? 'HTTP ' + r.httpStatus : ''}${r.diagnostic && r.diagnostic.httpStatus ? ' · ' + t('diagProvider') + ' HTTP ' + r.diagnostic.httpStatus : ''}${r.diagnostic && r.diagnostic.providerCode ? ' · ' + esc(r.diagnostic.providerCode) : ''}</span>` : ''}
        <span><b>${t('sourceLbl')}:</b> ${esc(t('liveFrom', { p: providerLabel }))}. ${t('demoNever')}</span>
        ${r.product ? `<span><b>${t('linkLbl')}:</b> <a href="${esc(r.product.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${esc(short(r.product.canonicalUrl, 70))}</a></span>` : ''}
      </div>
      ${buttons.length ? `<div class="row live-actions">${buttons.join('')}</div>` : ''}
    </div>`;
  }

  const SENT_CHIP = { positive: 'chip-pos', neutral: 'chip-unc', negative: 'chip-neg' };
  function aiLabel(rv) {
    const m = state.live && state.live.ai.merged; const l = m && m.sentiment[rv.reviewId];
    return l ? `<span class="chip ${SENT_CHIP[l]}">${t('ai_' + l)}</span>` : '';
  }
  function quote(rv) {
    if (!rv) return '';
    return `<figure class="ev-quote"><blockquote>“${esc(short(rv.text, 220))}”</blockquote><figcaption>${rv.rating != null ? `<span class="stars" aria-label="${rv.rating}/5">${stars(Math.round(rv.rating))}</span>` : ''}<span>${t('idNote')}: <code>${esc(rv.reviewId)}</code>${rv.idDerived ? ' (' + t('derivedId') + ')' : ''}</span>${aiLabel(rv)}</figcaption></figure>`;
  }

  function aiPanel(r) {
    const ai = r.ai, n = r.reviews.length, a = ai.analyzedIds.size;
    let body = '';
    if (ai.status === 'running') body = `<p class="live-line"><span class="spin" aria-hidden="true"></span>${t('stAnalyzing', { i: Math.min(ai.batchesDone + 1, ai.batchesTotal), n: ai.batchesTotal })}</p>`;
    else if (ai.status === 'summarising') body = `<p class="live-line"><span class="spin" aria-hidden="true"></span>${t('stSummarising')}</p>`;
    else if (ai.status === 'not_configured') body = `<p class="empty-note">${t('aiNotConfigured')}</p>`;
    else if (ai.status === 'failed') body = `<p class="empty-note">${esc(t('aiFailed', { m: STR.en['aiErr_' + ai.error] ? t('aiErr_' + ai.error) : (ai.error || '') }))}</p><div class="row"><button class="btn btn-primary btn-sm" type="button" id="ai-retry">${t('retry')}</button></div>`;
    else if (ai.status === 'idle') body = `<p class="empty-note">${t('aiIdle')}</p><div class="row"><button class="btn btn-primary btn-sm" type="button" id="ai-run">${t('runAi')}</button></div>`;
    else {
      const s = ai.summary;
      const list = (k, arr) => arr && arr.length ? `<div class="ai-list"><h3>${t(k)}</h3><ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
      body = `${s ? `<p class="lead">${esc(s.summary)}</p><div class="ai-lists">${list('aiPositives', s.positives)}${list('aiNegatives', s.negatives)}${list('aiRecurring', s.recurring_complaints)}${list('aiQuality', s.quality_insights)}</div>` : (ai.error ? `<p class="empty-note">${esc(t('aiFailed', { m: ai.error }))}</p>` : '')}
        <p class="basis">${t('aiNote')}</p>`;
    }
    const cov = ai.status === 'idle' || ai.status === 'not_configured' ? '' :
      `<p class="basis"><b>${a === n && n ? t('aiCoverageFull', { r: fmt(n) }) : t('aiCoverage', { a: fmt(a), r: fmt(n) })}</b>${ai.failedBatches ? ' ' + t('aiFailedBatches', { k: ai.failedBatches, ids: fmt(ai.failedIds.size) }) : ''}</p>
       ${ai.failedBatches && !['running', 'summarising', 'failed'].includes(ai.status) ? `<div class="row"><button class="btn btn-ghost btn-sm" type="button" id="ai-retry">${t('retryAi')}</button></div>` : ''}`;
    return `<div class="panel span-6 summary-panel"><div class="panel-head"><h2>${t('aiT')}</h2><span class="ai-badge">${t('aiBadge')}</span></div>${body}${cov}</div>`;
  }

  function findingsPanel(r) {
    const m = r.ai.merged; if (!m) return '';
    const byId = new Map(r.reviews.map(x => [x.reviewId, x]));
    const kindChip = { positive: 'chip-pos', negative: 'chip-neg', concern: 'chip-flag' };
    const kindLbl = { positive: 'kindPositive', negative: 'kindNegative', concern: 'kindConcern' };
    const items = m.findings.map(f => `<article class="finding">
        <div class="flag-top"><span class="chip ${kindChip[f.kind]}">${t(kindLbl[f.kind])}</span><span class="chip chip-unc">${esc(t('cat.' + f.category))}</span><h3>${esc(f.title)}</h3><span class="pill pill-soft">${t('supporting', { k: f.count })}</span></div>
        ${f.rationale ? `<p class="ai-rat"><b>${t('aiRationale')}:</b> ${esc(f.rationale)}</p>` : ''}
        <div class="ev"><span class="ev-lbl">${t('quoteLbl')}</span>${f.reviewIds.slice(0, 3).map(id => quote(byId.get(id))).join('')}</div>
        ${f.reviewIds.length > 3 ? `<details class="ids"><summary>${t('allIds')} (${f.reviewIds.length})</summary><p>${f.reviewIds.map(id => `<code>${esc(id)}</code>`).join(' ')}</p></details>` : ''}
      </article>`).join('');
    const signals = A.dataSignals(r.reviews).filter(s => s.type === 'date_burst').map(s => `<article class="finding">
        <div class="flag-top">${ICON.flag}<h3>${esc(t('sigBurstT', { k: s.count, n: s.of, d: s.day }))}</h3><span class="pill pill-soft">${t('supporting', { k: s.count })}</span></div>
        <p>${t('sigBurstD')}</p><div class="ev"><span class="ev-lbl">${t('quoteLbl')}</span>${s.reviewIds.slice(0, 2).map(id => quote(byId.get(id))).join('')}</div></article>`).join('');
    return `<div class="panel span-6"><div class="panel-head"><h2>${t('findingsT')}</h2><span class="panel-sub">${t('findingsSub')}</span></div>
      ${items || signals ? `<div class="findings">${items}${signals}</div>` : `<p class="empty-note">${t('noFindings')}</p>`}
      <p class="help">${t('concernNote')}</p></div>`;
  }

  function liveSellerPanel(r, a) {
    const s = A.ratingStats(r.reviews), ps = r.productSummary || {};
    const row = (k, v, note) => `<div class="seller-row"><span class="k">${k}</span><span class="v ${v ? '' : 'na'}">${v ? esc(v) : t('notAvail')}</span><span class="note">${note || ''}</span></div>`;
    return `<div class="panel span-3"><div class="panel-head"><h2>${t('sellerT')}</h2><span class="panel-sub">${t('sellerSub')}</span></div>
      <p class="empty-note" style="padding:.2rem 0 .6rem">${t('sellerLiveNote')}</p>
      <div class="seller-rows">
        ${row(t('pTotal'), r.reportedTotal != null && r.provider && r.provider.reportedTotalKind === 'product_total' ? fmt(r.reportedTotal) : '', '')}
        ${row(t('pAvg'), ps.averageRating != null ? Number(ps.averageRating).toFixed(1) + ' / 5' : '', '')}
        ${row(t('pVerified'), s.verifiedKnown ? `${fmt(s.verifiedCount)}` : '', s.verifiedKnown ? t('pVerifiedN', { v: fmt(s.verifiedCount), k: fmt(s.verifiedKnown) }) : '')}
        ${row(t('pMedia'), String(s.withMedia), '')}
        ${row(t('sService'), String(a.service.pos.length + a.service.neg.length), t('nService', { p: a.service.pos.length, n: a.service.neg.length }))}
      </div></div>`;
  }

  // ---------- Six-step workflow tracker (each step reflects real state) ----------
  function workflowPanel(r) {
    const ai = r.ai, n = r.reviews.length, m = ai.merged;
    const aiRunning = ai.status === 'running' || ai.status === 'summarising';
    const aiDone = ai.status === 'done' || ai.status === 'partial';
    const retrieving = r.kind === 'link' && r.phase === 'retrieving';
    const step = (num, key, st, detail) => `<li class="wf-step wf-${st}"><span class="wf-num">${st === 'done' ? '✓' : num}</span><div><b>${t('wf' + num)}</b><span class="wf-st">${t('wfs_' + st)}</span><span class="wf-d">${esc(detail)}</span></div></li>`;
    const s1 = step(1, 'submit', 'done', r.kind === 'link' ? t('wf1Link') : t('wf1Manual', { n: fmt(n) }));
    const s2 = r.kind === 'manual' ? step(2, 'retrieve', 'done', t('wf2Manual'))
      : step(2, 'retrieve', retrieving ? 'run' : !n ? 'fail' : r.complete ? 'done' : 'warn', retrieving ? t('stLoading') : n ? `${fmt(n)}${r.reportedTotal != null ? '/' + fmt(r.reportedTotal) : ''} · ${r.complete ? t('vComplete') : t('vPartial')}` : reasonText(r));
    const aiState = ai.status === 'not_configured' || ai.status === 'failed' ? 'fail' : aiRunning ? 'run' : aiDone ? (ai.analyzedIds.size < n ? 'warn' : 'done') : 'wait';
    const s3 = step(3, 'classify', !n ? 'wait' : aiState, ai.status === 'not_configured' ? t('aiNotConfiguredShort') : ai.status === 'failed' ? t('wfFailed') : aiRunning ? t('stAnalyzing', { i: Math.min(ai.batchesDone + 1, ai.batchesTotal || 1), n: ai.batchesTotal || 1 }) : m ? t('wf3Done', { a: fmt(ai.analyzedIds.size), n: fmt(n) }) : t('wfWaiting'));
    const flags = state.result ? state.result.flags.filter(f => f.id !== 'small').length : 0;
    const s4 = step(4, 'themes', m ? 'done' : state.result ? (aiRunning ? 'run' : 'warn') : 'wait', m ? t('wf4Done', { f: m.findings.length, c: m.findings.filter(f => f.kind === 'concern').length, k: flags }) : state.result ? t('wf4Rules', { k: flags }) : t('wfWaiting'));
    const rs = ai.reportStatus;
    const s5 = rs === 'running' ? step(5, 'report', 'run', t('rpRunning'))
      : rs === 'done' ? step(5, 'report', 'done', t('wf5Done'))
      : rs === 'error' ? step(5, 'report', 'warn', t('wf5ReportFailed'))
      : rs === 'insufficient' ? step(5, 'report', 'warn', t('wf5Insufficient'))
      : step(5, 'report', state.result && !aiRunning && !retrieving ? 'warn' : state.result ? 'run' : 'wait', state.result && !aiRunning && !retrieving ? t('wf5Rules') : t('wfWaiting'));
    const aiDead = ai.status === 'failed' || ai.status === 'not_configured';
    const s6 = step(6, 'decide', ai.decision && !aiRunning ? 'done' : aiRunning ? 'run' : aiDead ? 'fail' : 'wait', ai.decision && !aiRunning ? t('stance_' + ai.decision.stance) : aiDead ? t('wf6NoAi') : t('wfWaiting'));
    return `<div class="panel span-6"><div class="panel-head"><h2>${t('wfT')}</h2><span class="pill ${r.kind === 'link' ? 'pill-live' : 'pill-soft'}">${r.kind === 'link' ? t('liveTag') : t('manualTag')}</span></div><ol class="wf">${s1}${s2}${s3}${s4}${s5}${s6}</ol></div>`;
  }

  // ---------- Step 3: Gemini sentiment per review ----------
  function aiSentimentPanel(r) {
    const m = r.ai.merged; if (!m) return '';
    const c = m.sentimentCounts, cls = c.positive + c.neutral + c.negative;
    const segs = [['positive', 'var(--pos)'], ['neutral', '#CFC6C9'], ['negative', 'var(--neg)']];
    const p = k => cls ? Math.round(c[k] / cls * 1000) / 10 : 0;
    return `<div class="panel span-6"><div class="panel-head"><h2>${t('aiSentT')}</h2><span class="ai-badge">${t('aiSentBadge')}</span></div>
      <div class="bar bar-lg" role="img" aria-label="${segs.map(([k]) => `${t('ai_' + k)} ${c[k]}`).join(', ')}">${segs.filter(([k]) => c[k]).map(([k, col]) => `<span style="width:${p(k)}%;background:${col}"></span>`).join('')}</div>
      <div class="sent-rows">${segs.map(([k, col]) => `<div class="r"><span><i class="dot" style="background:${col}"></i>${t('ai_' + k)}</span><div class="track"><span style="width:${p(k)}%;background:${col}"></span></div><span class="n">${fmt(c[k])} · ${p(k)}%</span></div>`).join('')}</div>
      <p class="basis">${t('aiSentBasis', { k: fmt(cls), n: fmt(r.reviews.length) })}${c.unclassified ? ' ' + t('aiSentUnclassified', { u: fmt(c.unclassified) }) : ''}</p></div>`;
  }

  function fullQuote(rv) {
    if (!rv) return '';
    const text = rv.text.length > 600 ? rv.text.slice(0, 600) + '…' : rv.text;
    return `<figure class="ev-quote"><blockquote>“${esc(text)}”</blockquote><figcaption>${rv.rating != null ? `<span class="stars" aria-label="${rv.rating}/5">${stars(Math.round(rv.rating))}</span>` : ''}<span>${t('idNote')}: <code>${esc(rv.reviewId)}</code>${rv.idDerived ? ' (' + t('derivedId') + ')' : ''}</span></figcaption></figure>`;
  }
  function sourceLabel(r) {
    return r.kind === 'link' ? t('rpSrcLive', { p: r.provider ? r.provider.label : '?' }) : state.imported && state.imported.reviews === r.reviews ? t('rpSrcImport', { f: state.imported.name }) : t('rpSrcPasted');
  }

  function reportPanel(r) {
    const ai = r.ai, st = ai.reportStatus;
    if (ai.status === 'failed' || ai.status === 'not_configured') return `<div class="panel span-6 report-panel"><div class="panel-head"><h2>${t('rpT')}</h2><span class="ai-badge">${t('aiBadge')}</span></div><p class="empty-note">${t('rpNeedsAi')}</p></div>`;
    if (!st || ai.status === 'running' || ai.status === 'summarising') return `<div class="panel span-6 report-panel"><div class="panel-head"><h2>${t('rpT')}</h2><span class="ai-badge">${t('aiBadge')}</span></div><p class="empty-note">${t('rpWaiting')}</p></div>`;
    const byId = new Map(r.reviews.map(x => [x.reviewId, x]));
    const pn = productName(r);
    const n = ai.analyzedIds.size;
    const meta = `<p class="rp-meta"><span class="pill ${r.kind === 'link' ? 'pill-live' : 'pill-soft'}">${esc(sourceLabel(r))}</span> ${t('rpCount', { a: fmt(n), r: fmt(r.reviews.length) })}</p>`;
    let body;
    if (st === 'running') body = `<p class="live-line"><span class="spin" aria-hidden="true"></span>${t('rpRunning')}</p>`;
    else if (st === 'insufficient') body = `<p class="empty-note">${t('rpInsufficient', { n: fmt(n) })}</p>`;
    else if (st === 'error') body = `<p class="empty-note">${esc(t('rpError', { m: STR.en['aiErr_' + ai.reportError] ? t('aiErr_' + ai.reportError) : ai.reportError }))}</p><div class="row"><button class="btn btn-primary btn-sm" type="button" id="rp-retry">${t('retry')}</button></div>`;
    else {
      const rp = ai.report;
      const theme = (x, neg) => `<article class="rp-theme"><h4>${esc(x.heading)} <span class="pill ${x.support >= 2 ? 'pill-soft' : 'pill-line'}">${x.support >= 2 ? t('rpRecurring', { k: x.support }) : t('rpIsolated')}</span></h4>
        <p>${esc(x.explanation)}</p>${neg && x.impact ? `<p class="rp-impact"><b>${t('rpImpact')}:</b> ${esc(x.impact)}</p>` : ''}
        <div class="ev"><span class="ev-lbl">${t('quoteLbl')}</span>${x.review_ids.map(id => fullQuote(byId.get(id))).join('')}</div></article>`;
      const notes = [];
      if (n < 30) notes.push(t('rpSmall', { n: fmt(n) }));
      if (n < r.reviews.length || (r.kind === 'link' && !r.complete)) notes.push(t('rpPartial'));
      if (ai.reportLang && ai.reportLang !== lang) notes.push(t('rpLangNote'));
      body = `<p class="rp-intro">${t('rpIntro', { name: `<b>${esc(pn.name)}</b>${pn.byUser ? ' ' + t('rpNameByUser') : ''}` })}</p>
        ${notes.length ? `<ul class="rp-notes">${notes.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
        <h3 class="rp-h">👍 ${t('rpPos')}</h3>${rp.positives.length ? rp.positives.map(x => theme(x, false)).join('') : `<p class="empty-note">${t('rpNoPos')}</p>`}
        <h3 class="rp-h">👎 ${t('rpNeg')}</h3>${rp.negatives.length ? rp.negatives.map(x => theme(x, true)).join('') : `<p class="empty-note">${t('rpNoNeg')}</p>`}
        <h3 class="rp-h">📝 ${t('rpBefore')}</h3><ul class="rp-list">${(rp.before_buying.length ? rp.before_buying : [t('rpBeforeFallback')]).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="basis">${t('rpBasis')}</p>
        <div class="row">${ai.reportLang !== lang ? `<button class="btn btn-ghost btn-sm" type="button" id="rp-retry">${t('rpRegen')}</button>` : ''}<button class="btn btn-ghost btn-sm" type="button" id="rp-copy">${ICON.copy}${t('rpCopy')}</button></div>`;
    }
    return `<div class="panel span-6 report-panel" id="vi-report"><div class="panel-head"><h2>${t('rpT')}</h2><span class="ai-badge">${t('aiBadge')}</span></div>${meta}${body}</div>`;
  }

  function reportPlain(r) {
    const ai = r.ai, rp = ai.report; if (!rp) return '';
    const byId = new Map(r.reviews.map(x => [x.reviewId, x]));
    const pn = productName(r), L = [];
    L.push(t('rpIntro', { name: pn.name + (pn.byUser ? ' ' + t('rpNameByUser') : '') }));
    L.push(`(${sourceLabel(r)} · ${t('rpCount', { a: ai.analyzedIds.size, r: r.reviews.length })})`, '');
    const block = (x, neg) => {
      L.push(`**${x.heading}** — ${x.support >= 2 ? t('rpRecurring', { k: x.support }) : t('rpIsolated')}`, x.explanation);
      if (neg && x.impact) L.push(`${t('rpImpact')}: ${x.impact}`);
      x.review_ids.forEach(id => { const v = byId.get(id); if (v) L.push(`  “${v.text}” (${t('idNote')} ${id})`); });
      L.push('');
    };
    L.push('👍 ' + t('rpPos')); if (rp.positives.length) rp.positives.forEach(x => block(x, false)); else L.push(t('rpNoPos'), '');
    L.push('👎 ' + t('rpNeg')); if (rp.negatives.length) rp.negatives.forEach(x => block(x, true)); else L.push(t('rpNoNeg'), '');
    L.push('📝 ' + t('rpBefore')); (rp.before_buying.length ? rp.before_buying : [t('rpBeforeFallback')]).forEach(x => L.push('- ' + x));
    if (ai.analyzedIds.size < 30) L.push('', t('rpSmall', { n: ai.analyzedIds.size }));
    L.push('', t('rpBasis'));
    return L.join('\n');
  }
  function copyText(text) {
    const done = ok => toast(ok ? t('copied') : t('copyFail'));
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch (e) { done(false); }
  }

  // ---------- Credibility signals (ratios from the reviews; no score) ----------
  function credibilityPanel(r) {
    const m = r.ai.merged; if (!m) return '';
    const s = A.credibilitySignals(m, r.reviews);
    const pc = x => x == null ? t('vNA') : Math.round(x * 1000) / 10 + '%';
    const row = (k, v, how) => `<div class="seller-row"><span class="k">${k}</span><span class="v ${v === t('vNA') ? 'na' : ''}">${esc(v)}</span><span class="note">${how}</span></div>`;
    return `<div class="panel span-6"><div class="panel-head"><h2>${t('credT')}</h2><span class="panel-sub">${t('credSub')}</span></div>
      <div class="seller-rows">
        ${row(t('credCons'), pc(s.consistency.share), t('credConsHow', { k: s.consistency.k, n: s.consistency.n, l: t('ai_' + s.consistency.majority).toLowerCase() }))}
        ${row(t('credReach'), pc(s.complaintReach.share), t('credReachHow', { k: s.complaintReach.k, n: s.complaintReach.n }))}
        ${row(t('credTop'), s.topComplaint ? pc(s.topComplaint.share) : t('vNA'), s.topComplaint ? t('credTopHow', { title: esc(s.topComplaint.title), k: s.topComplaint.k, n: s.topComplaint.n }) : t('credTopNone'))}
        ${row(t('credGap'), s.polarityGap == null ? t('vNA') : (s.polarityGap >= 0 ? '+' : '') + Math.round(s.polarityGap * 1000) / 10 + ' ' + t('pp'), t('credGapHow'))}
        ${row(t('credAgree'), pc(s.ratingAgreement.share), s.ratingAgreement.n ? t('credAgreeHow', { k: s.ratingAgreement.k, n: s.ratingAgreement.n }) : t('credAgreeNone'))}
      </div>
      <p class="help">${hasSellerData(r) ? t('limSellerUser') : t('limSeller')} ${t('credNoScore')}</p></div>`;
  }

  // ---------- Step 6: evidence-based decision summary ----------
  function decisionPanel(r) {
    const d = r.ai.decision; if (!d) return '';
    const s = r.ai.summary;
    const pct = x => Math.round(x * 1000) / 10 + '%';
    const li = f => `<li>${esc(f.title)} <span class="pill pill-soft">${t('supporting', { k: f.count })}</span></li>`;
    const block = (k, arr) => arr.length ? `<div class="ai-list"><h3>${t(k)}</h3><ul>${arr.map(li).join('')}</ul></div>` : '';
    return `<div class="panel span-6 decision-panel" id="decision"><div class="panel-head"><h2>${t('decT')}</h2><span class="pill stance-${d.stance}">${t('stance_' + d.stance)}</span><span class="pill pill-line">${t('certLbl')}: ${t('cert_' + d.certainty)}</span></div>
      <p class="lead">${t('decStats', { pos: pct(d.shares.positive), neu: pct(d.shares.neutral), neg: pct(d.shares.negative), k: fmt(d.classified), n: fmt(d.retrieved) })}</p>
      <div class="ai-lists">${block('decPros', d.positives)}${block('decCons', d.complaints)}${block('decConcerns', d.concerns)}</div>
      ${d.unknowns.length ? `<div class="ai-list"><h3>${t('decUnknowns')}</h3><ul>${d.unknowns.map(u => `<li>${t('unk_' + u)}</li>`).join('')}</ul></div>` : ''}
      ${s && s.decision_rationale ? `<p class="ai-rat"><b>${t('aiRationale')}:</b> ${esc(s.decision_rationale)}</p>` : ''}
      ${s && s.before_buying && s.before_buying.length ? `<div class="ai-list"><h3>${t('aiBefore')} <span class="ai-badge">AI</span></h3><ul>${s.before_buying.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <p class="basis">${t('decRule')} ${t('certRule')}</p><p class="help">${t('decDisclaimer')}</p></div>`;
  }

  function limitsPanel(r) {
    const items = [
      r.kind === 'link' ? `${r.complete ? t('vComplete') : t('vPartial')}${r.stopReason ? ' · ' + reasonText(r) : ''}` : t('limManual'),
      r.ai.status === 'idle' || r.ai.status === 'not_configured' ? t('aiNotConfigured') : t('aiCoverage', { a: fmt(r.ai.analyzedIds.size), r: fmt(r.reviews.length) }),
      t('limSentiment'), hasSellerData(r) ? t('limSellerUser') : t('limSeller'), t('limFlags'), t('limValid')
    ];
    return `<div class="panel span-6"><div class="panel-head"><h2>${t('limT')}</h2></div><ul class="lim-list">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  }

  // ---------- Step 5: structured report (copy / download) ----------
  function runReportText(r) {
    const a = state.result, ai = r.ai, m = ai.merged, d = ai.decision, L = [];
    const byId = new Map(r.reviews.map(x => [x.reviewId, x]));
    L.push(`${t('reportHead')} — ${new Date().toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB')}`);
    L.push(`${t('sourceLbl')}: ${r.kind === 'link' ? t('liveFrom', { p: r.provider ? r.provider.label : '?' }) + (r.product ? ` · ${t('kProduct')} ${r.product.productId} · ${r.product.canonicalUrl}` : '') : t('srcPasted')}`);
    if (r.kind === 'link') L.push(`${t('kReported')}: ${fmt(r.reportedTotal)} · ${t('kRetrieved')}: ${fmt(r.retrieved)} · ${t('kUnique')}: ${fmt(r.reviews.length)} · ${t('kPages')}: ${fmt(r.pages)} · ${t('kStatus')}: ${r.complete ? t('vComplete') : t('vPartial')}${r.stopReason ? ' (' + reasonText(r) + ')' : ''}`);
    else L.push(`${t('kUnique')}: ${fmt(r.reviews.length)}`);
    L.push(`${t('kAnalyzed')}: ${fmt(ai.analyzedIds.size)}/${fmt(r.reviews.length)}`);
    if (a) L.push(`${t('avgRating')}: ${a.avg != null ? a.avg.toFixed(1) + '/5 (' + a.rated + ')' : t('vNA')}`);
    if (ai.report) L.push('', reportPlain(r), '', '———');
    if (m) {
      const c = m.sentimentCounts;
      L.push('', `${t('aiSentT')}: ${t('ai_positive')} ${c.positive}, ${t('ai_neutral')} ${c.neutral}, ${t('ai_negative')} ${c.negative}${c.unclassified ? ', ' + t('unclassifiedLbl') + ' ' + c.unclassified : ''}`);
      if (ai.summary) L.push('', `${t('aiT')} [AI]: ${ai.summary.summary}`);
      L.push('', `${t('findingsT')}:`);
      m.findings.forEach(f => {
        L.push(`- [${t({ positive: 'kindPositive', negative: 'kindNegative', concern: 'kindConcern' }[f.kind])} · ${t('cat.' + f.category)}] ${f.title} — ${t('supporting', { k: f.count })}`);
        f.reviewIds.slice(0, 2).forEach(id => { const x = byId.get(id); if (x) L.push(`    “${short(x.text, 160)}” (${t('idNote')} ${id})`); });
      });
    }
    if (a) { L.push('', `${t('flagsT')} (${t('ruleShort')}):`); const fl = a.flags.filter(f => f.id !== 'small'); if (!fl.length) L.push(`- ${t('noFlags')}`); fl.forEach(f => L.push(`- ${t(f.id + 'T', f.vars)}`)); }
    if (d) {
      L.push('', `${t('decT')}: ${t('stance_' + d.stance)} · ${t('certLbl')}: ${t('cert_' + d.certainty)}`);
      const cs = A.credibilitySignals(m, r.reviews), pc = x => x == null ? t('vNA') : Math.round(x * 1000) / 10 + '%';
      L.push(`${t('credT')}: ${t('credCons')} ${pc(cs.consistency.share)} (${cs.consistency.k}/${cs.consistency.n}); ${t('credReach')} ${pc(cs.complaintReach.share)} (${cs.complaintReach.k}/${cs.complaintReach.n}); ${t('credAgree')} ${pc(cs.ratingAgreement.share)} (${cs.ratingAgreement.k}/${cs.ratingAgreement.n})`);
      L.push(t('decStats', { pos: Math.round(d.shares.positive * 1000) / 10 + '%', neu: Math.round(d.shares.neutral * 1000) / 10 + '%', neg: Math.round(d.shares.negative * 1000) / 10 + '%', k: d.classified, n: d.retrieved }));
      d.unknowns.forEach(u => L.push(`- ${t('unk_' + u)}`));
      if (ai.summary && ai.summary.decision_rationale) L.push(`[AI] ${ai.summary.decision_rationale}`);
      if (ai.summary) (ai.summary.before_buying || []).forEach(x => L.push(`- [AI] ${x}`));
    }
    L.push('', `${t('limT')}:`, `- ${t('limSentiment')}`, `- ${t('limFlags')}`, `- ${t('limValid')}`, '', t('reportWarn'));
    return L.join('\n');
  }
  const baseReportText = reportText;
  reportText = function () { return isRunView() ? runReportText(state.live) : baseReportText(); };
  function downloadReport() {
    try {
      const blob = new Blob([reportText()], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'trustlens-report.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(t('copyFail')); }
  }

  function currentManualReviews() {
    if (state.imported && state.imported.text === $('#dash-reviews').value) return state.imported.reviews;
    return parseReviews($('#dash-reviews').value).map((x, i) => A.normalizeReview({ id: 'USR-' + String(i + 1).padStart(3, '0'), text: x.text, rating: x.rating }, { source: 'pasted' })).filter(Boolean);
  }

  const baseRenderMain = renderMain;
  renderMain = function () {
    const r = state.live;
    if (!isRunView()) return baseRenderMain();
    const main = $('#dash-main');
    const a = state.result;
    let html = workflowPanel(r) + statusPanel(r);
    if (!a) {
      if (r.phase !== 'retrieving' && !r.reviews.length) {
        const empty = r.complete || r.stopReason === 'exhausted';
        html += `<div class="panel span-6 notice"><span class="ic">${ICON.link}</span><h2>${t(empty ? 'noReviewsT' : 'failT')}</h2><p>${empty ? t('noReviewsD') : esc(reasonText(r))}</p>
          <div class="row"><button class="btn btn-primary btn-sm" type="button" id="notice-paste">${t('pasteBtn')}</button><button class="btn btn-ghost btn-sm" type="button" data-demo="headphones">${t('demoBtn')}</button></div></div>`;
      }
      main.innerHTML = `<div class="results">${html}</div>`;
    } else {
      main.innerHTML = `<div class="results">${html}${reportPanel(r)}${decisionPanel(r)}${aiPanel(r)}${aiSentimentPanel(r)}${credibilityPanel(r)}${findingsPanel(r)}
        <h2 class="span-6 rule-head">${t('ruleHead')}</h2>
        ${overviewPanel(a)}${sentimentPanel(a)}${themesPanel(a)}${complaintsPanel(a)}${flagsPanel(a)}${r.kind === 'link' ? liveSellerPanel(r, a) : sellerPanel(a)}${excerptsPanel(a)}${limitsPanel(r)}
        <div class="span-6 row"><button class="btn btn-ghost btn-sm" type="button" id="act-copy">${ICON.copy}${t('copy')}</button><button class="btn btn-ghost btn-sm" type="button" id="act-download">${t('download')}</button></div></div>`;
      $('#act-copy').addEventListener('click', copyReport);
      $('#act-download').addEventListener('click', downloadReport);
      $$('[data-filter]', main).forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderMain(); const el = $('[data-filter="' + state.filter + '"]'); if (el) el.focus(); }));
    }
    const on = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
    on('live-cancel', cancel);
    on('live-continue', continueRetrieval);
    on('live-retry', () => start(r.url));
    on('rp-retry', () => { r.cancelled = false; r.controller = new AbortController(); generateReport(r); });
    on('rp-copy', () => copyText(reportPlain(r)));
    on('live-editlink', () => { const u = $('#dash-url'); u.value = r.url; u.focus(); u.select(); });
    on('live-paste', () => { state.source = { type: 'manual' }; $('#dash-url').value = ''; const ta = $('#dash-reviews'); ta.scrollIntoView({ block: 'center' }); ta.focus(); toast(t('pasteHint')); });
    on('notice-paste', () => { state.source = { type: 'manual' }; $('#dash-reviews').focus(); });
    bindAi(r);
  };
  function bindAi(r) {
    const go = () => { r.cancelled = false; r.controller = new AbortController(); runAI(r); };
    const a = $('#ai-retry'); if (a) a.addEventListener('click', go);
    const b = $('#ai-run'); if (b) b.addEventListener('click', go);
  }

  const baseSourceInfo = sourceInfo;
  sourceInfo = function () {
    if (isRunView() && state.live.kind === 'link') return { demo: false, text: t('srcLive', { p: state.live.provider ? state.live.provider.label : '?', n: state.live.reviews.length }) };
    return baseSourceInfo();
  };

  // ---------- CSV / JSON import (manual mode) ----------
  function parseCsv(raw) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q) { if (c === '"' && raw[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && raw[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const nonEmpty = rows.filter(r => r.some(x => x.trim()));
    if (nonEmpty.length < 2) return [];
    const head = nonEmpty[0].map(h => h.trim().toLowerCase());
    return nonEmpty.slice(1).map(cells => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])));
  }
  $('#dash-file').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const status = $('#dash-file-status');
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('> 5 MB');
      const raw = await f.text();
      let rows = [];
      if (/\.json$/i.test(f.name)) { const o = JSON.parse(raw); rows = Array.isArray(o) ? o : (Array.isArray(o.reviews) ? o.reviews : []); }
      else rows = parseCsv(raw);
      const reviews = rows.map(x => A.normalizeReview(x, { source: 'import', prefix: 'IMP' })).filter(Boolean);
      const seen = R.dedupe(reviews).unique;
      if (!seen.length) throw new Error(t('importNone'));
      const text = seen.map(x => (x.rating != null ? Math.round(x.rating) + '★ ' : '') + x.text).join('\n');
      $('#dash-reviews').value = text; $('#dash-url').value = '';
      state.imported = { text, reviews: seen, name: f.name };
      state.source = { type: 'manual' };
      status.textContent = t('importOk', { n: seen.length, f: f.name });
    } catch (err) {
      state.imported = null;
      status.textContent = t('importFail', { m: err.message });
    }
  });
  // Imported reviews keep their own IDs in the rule-based engine too.
  // Pasted/imported reviews go through the same steps 3–6 as retrieved ones (demo products do not).
  const baseRun = window.run;
  window.run = function () {
    // Never carry demo product/seller details into an analysis of real reviews.
    if (state.source.type === 'manual' && state.detailsFromDemo) { setDetails({}); state.detailsFromDemo = false; }
    const ok = baseRun();
    if (!ok || !state.result || state.source.type !== 'manual') return ok;
    const reviews = currentManualReviews();
    if (!reviews.length) return ok;
    if (state.live) { state.live.cancelled = true; state.live.controller.abort(); }
    const r = run = newRun('', 'manual');
    r.reviews = reviews; r.phase = 'retrieved'; r.complete = true; r.stopReason = null;
    state.live = r;
    rebuildResult(r);
    paint();
    setBusy(true);
    runAI(r).finally(() => { if (r === run) setBusy(false); });
    return ok;
  };

  // ---------- Keep the original synthetic sample datasets from data/ available as demos ----------
  Promise.all(['bluetooth_headphones_x', 'bluetooth_headphones_x_charging_issue', 'matte_lip_cream_y'].map(id =>
    fetch(id + '.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null))).then(list => {
    list.filter(Boolean).forEach(ds => {
      if (DEMOS.some(d => d.id === ds.id)) return;
      SVG[ds.id] = SVG.generic;
      DEMOS.push({ id: ds.id, name: { en: ds.name, vi: ds.name }, cat: { en: STR.en.sampleSynthetic, vi: STR.vi.sampleSynthetic }, price: '–', seller: {}, reviews: ds.reviews.map(r => [r.rating, r.text]) });
    });
    renderDemoCards(); renderSideDemos();
  });

  // Tech-stack status: report only what this deployment actually has configured.
  let health; // undefined until /api/health answers
  function paintHealth() {
    const el = $('#stack-status'); if (!el) return;
    el.textContent = !health ? t('hsNA') : t('hsOk', { p: health.reviewProviderReady ? t('hsYes') : t('hsNo'), a: health.aiReady ? t('hsYes') : t('hsNo') });
  }
  fetch('/api/health', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null).then(h => { health = h && h.ok ? h : null; paintHealth(); });
  const baseApplyLang = applyLang;
  applyLang = function () { baseApplyLang(); if (health !== undefined) paintHealth(); };

  window.TL_live = { start, cancel, continueRetrieval, get run() { return run; } };
  applyLang(); // re-apply so the extra strings and the language saved in this browser take effect
})();
