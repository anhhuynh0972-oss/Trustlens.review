// Review-provider adapters (server-side only; keys come from process.env and never leave the server).
//
// Social Fetch — https://www.socialfetch.dev/docs/api/v1/tiktok/products/reviews/get.mdx
//   GET https://api.socialfetch.dev/v1/tiktok/products/reviews?url=&region=&page=   header x-api-key
//   Synchronous, page-number pagination: data.page.{currentPage,nextPage,hasMore}; data.summary.totalReviews.
//   1 credit per page. 402 insufficient_credits, 401 unauthorized, 502 lookup_failed (retry), 503 concurrency (retry).
//
// SocQ — https://docs.socq.ai/api-manual/tiktok-shop/product-reviews
//   POST /v1/tiktok-shop/product-reviews {url, results_limit, region} -> data.task_id (async, billed per saved review)
//   GET  /v1/tasks/{id}?cursor=&limit= -> data.status (queued|running|succeeded|failed), data.results.{items,next_cursor,has_more}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./retrieve.js'));
  else root.TL_providers = factory(root.TL_retrieve);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';
  const { ProviderError, classifyHttp } = R;
  const REQUEST_TIMEOUT_MS = 15000;

  async function requestJson(doFetch, url, init) {
    let res;
    try {
      res = await doFetch(url, Object.assign({}, init, { signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined }));
    } catch (e) {
      throw new ProviderError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'upstream', 'Could not reach the review provider.');
    }
    const text = await res.text();
    const err = classifyHttp(res.status, text, res.headers);
    if (err) throw err;
    try { return text ? JSON.parse(text) : {}; } catch (e) { throw new ProviderError('bad_response', 'Provider returned invalid JSON.'); }
  }

  function socialFetch(env, doFetch) {
    const base = (env.SOCIALFETCH_BASE_URL || 'https://api.socialfetch.dev').replace(/\/+$/, '');
    const region = env.REVIEW_REGION || 'VN';
    return {
      name: 'socialfetch',
      label: 'Social Fetch',
      reportedTotalKind: 'product_total',
      // Social Fetch is synchronous; nothing to start.
      async start() { return { ready: true, state: {} }; },
      async fetchPage(ctx, cursor) {
        const page = cursor == null ? 1 : Number(cursor);
        if (!Number.isInteger(page) || page < 1 || page > 10000) throw new ProviderError('bad_request', 'Invalid page cursor.');
        const q = new URLSearchParams({ url: ctx.canonicalUrl, region, page: String(page) });
        const body = await requestJson(doFetch, `${base}/v1/tiktok/products/reviews?${q}`, { method: 'GET', headers: { 'x-api-key': env.SOCIALFETCH_API_KEY, Accept: 'application/json', 'User-Agent': 'TrustLens/2.0 (review analysis; server-side API client)' } });
        const data = body && body.data;
        if (!data || typeof data !== 'object') throw new ProviderError('bad_response', 'Provider response had no data.');
        if (data.lookupStatus === 'not_found') throw new ProviderError('not_found', 'The provider could not find this product in the selected region.');
        if (!Array.isArray(data.reviews)) throw new ProviderError('bad_response', 'Provider response had no review list.');
        const p = data.page || {};
        const s = data.summary || {};
        return {
          items: data.reviews,
          nextCursor: p.nextPage != null ? String(p.nextPage) : null,
          hasMore: p.hasMore === true && p.nextPage != null,
          reportedTotal: Number.isFinite(Number(s.totalReviews)) && s.totalReviews !== null ? Number(s.totalReviews) : null,
          productSummary: { averageRating: s.averageRating ?? null, ratingDistribution: s.ratingDistribution || null },
          credits: body.meta && body.meta.creditsCharged != null ? Number(body.meta.creditsCharged) : null
        };
      }
    };
  }

  function socq(env, doFetch) {
    const base = (env.SOCQ_BASE_URL || 'https://api.socq.ai').replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${env.SOCQ_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    const resultsLimit = Math.min(2000, Math.max(20, Number(env.SOCQ_RESULTS_LIMIT) || 500));
    return {
      name: 'socq',
      label: 'SocQ',
      reportedTotalKind: 'provider_collected',
      // Submit once (never auto-retried: a duplicate submit can be billed twice), or reuse a task ID from a resume token.
      async start(ctx, resume, deadlineMs, sleep, now) {
        let taskId = resume && resume.taskId;
        if (!taskId) {
          const sub = await requestJson(doFetch, `${base}/v1/tiktok-shop/product-reviews`, { method: 'POST', headers, body: JSON.stringify({ url: ctx.canonicalUrl, results_limit: resultsLimit, region: env.REVIEW_REGION || 'VN' }) });
          taskId = sub && sub.data && sub.data.task_id;
          if (!taskId) throw new ProviderError('bad_response', 'Provider did not return a task ID.');
        }
        // Poll until the task finishes or the time budget runs out (then the client resumes with the task ID).
        let delay = 1500;
        while (now() + delay < deadlineMs) {
          const t = await requestJson(doFetch, `${base}/v1/tasks/${encodeURIComponent(taskId)}?limit=1`, { method: 'GET', headers });
          const st = t && t.data && t.data.status;
          if (st === 'succeeded') return { ready: true, state: { taskId, resultCount: t.data.result_count ?? null } };
          if (st === 'failed') throw new ProviderError('bad_request', 'The provider task failed: ' + String(t.data.error_message || 'unknown reason').slice(0, 200));
          await sleep(delay);
          delay = Math.min(delay * 1.5, 5000);
        }
        return { ready: false, state: { taskId } };
      },
      async fetchPage(ctx, cursor, state) {
        const q = new URLSearchParams({ limit: '50' });
        if (cursor != null) q.set('cursor', String(cursor));
        const body = await requestJson(doFetch, `${base}/v1/tasks/${encodeURIComponent(state.taskId)}?${q}`, { method: 'GET', headers });
        const d = body && body.data;
        const r = d && d.results;
        if (!r || !Array.isArray(r.items)) throw new ProviderError('bad_response', 'Provider response had no review list.');
        return { items: r.items, nextCursor: r.next_cursor ?? null, hasMore: r.has_more === true, reportedTotal: d.result_count ?? state.resultCount ?? null };
      }
    };
  }

  // Pick the configured provider. REVIEW_PROVIDER may force one; otherwise Social Fetch wins when both keys exist.
  function selectProvider(env, doFetch) {
    const want = String(env.REVIEW_PROVIDER || '').toLowerCase();
    if ((want === 'socialfetch' || !want) && env.SOCIALFETCH_API_KEY) return socialFetch(env, doFetch);
    if ((want === 'socq' || !want) && env.SOCQ_API_KEY) return socq(env, doFetch);
    return null;
  }

  return { selectProvider, socialFetch, socq };
});
