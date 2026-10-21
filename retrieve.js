// Provider-agnostic pagination engine: follows cursors, deduplicates by stable review ID,
// retries transient failures, protects against loops/stalls and keeps partial results.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL_retrieve = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // kind: rate_limited | timeout | upstream | auth | credits | bad_request | bad_response | not_found
  class ProviderError extends Error {
    constructor(kind, message, opts) {
      super(message);
      this.kind = kind;
      this.status = opts && opts.status;
      this.retryAfterMs = opts && opts.retryAfterMs;
      this.providerCode = opts && opts.providerCode; // provider's own documented error code, e.g. lookup_failed
    }
  }
  const RETRYABLE = new Set(['rate_limited', 'timeout', 'upstream', 'lookup_failed']);
  const STOP_REASON_FOR = { lookup_failed: 'lookup_failed', rate_limited: 'rate_limited', timeout: 'provider_timeout', upstream: 'upstream_error', auth: 'auth_failed', credits: 'credits_exhausted', bad_request: 'provider_rejected', bad_response: 'bad_response', not_found: 'not_found' };

  // Classify an HTTP response from a provider into a ProviderError (or null when OK).
  function classifyHttp(status, bodyText, headers) {
    if (status >= 200 && status < 300) return null;
    const err = classifyKind(status, bodyText, headers);
    // Keep the provider's documented error code (Social Fetch {error:{code}}, SocQ {error:{type}}), sanitised.
    let code = null;
    try { const b = JSON.parse(bodyText); const e = b && (b.error || b); code = typeof e === 'object' ? (e.code || e.type || null) : (typeof b.error === 'string' ? b.error : null); } catch (e) { /* not JSON */ }
    if (code != null && /^[a-z][a-z0-9_]{0,40}$/i.test(String(code))) err.providerCode = String(code).toLowerCase();
    if (err.providerCode === 'lookup_failed') { err.kind = 'lookup_failed'; err.message = 'The provider could not look up this product right now.'; }
    return err;
  }
  function classifyKind(status, bodyText, headers) {
    const text = String(bodyText || '').toLowerCase();
    const ra = headers && (typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after']);
    const retryAfterMs = ra ? (isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now()) || undefined) : undefined;
    if (status === 402 || /insufficient (credit|balance)|out of credits|credit(s)? exhausted|quota exceeded|no credits/.test(text)) return new ProviderError('credits', 'Provider credits or quota exhausted.', { status });
    if (status === 401 || status === 403) return new ProviderError('auth', 'Provider rejected the API key or access.', { status });
    if (status === 429) return new ProviderError('rate_limited', 'Provider rate limit reached.', { status, retryAfterMs });
    if (status === 404) return new ProviderError('not_found', 'Provider could not find this product or task.', { status });
    if (status === 400 || status === 422) return new ProviderError('bad_request', 'Provider rejected the request for this product.', { status });
    if (status === 408 || status === 504) return new ProviderError('timeout', 'Provider timed out.', { status });
    return new ProviderError('upstream', 'Provider returned HTTP ' + status + '.', { status });
  }

  // Stable key for de-duplication: provider review ID when present, otherwise a content hash
  // (flagged as derived so the UI never presents it as a platform ID).
  function stableKey(review) {
    if (review.reviewId && !review.idDerived) return 'id:' + review.reviewId;
    return 'h:' + hash([review.text, review.rating, review.date, review.author].join('|'));
  }
  function hash(s) {
    let h1 = 0x811c9dc5, h2 = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = (h2 * 31 + c) >>> 0; }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function dedupe(reviews, seen) {
    seen = seen || new Set();
    const out = []; let duplicates = 0;
    for (const r of reviews) {
      const k = stableKey(r);
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k); out.push(r);
    }
    return { unique: out, duplicates, seen };
  }

  /**
   * paginate(options)
   *   fetchPage(cursor) -> { items: rawItem[], nextCursor, hasMore, reportedTotal? }
   *   normalize(rawItem, index) -> review | null
   *   startCursor, maxPages, deadlineMs (epoch), maxRetries, stallLimit,
   *   seenKeys (array of keys already held by the client, for resume), sleep, now, isCancelled
   */
  async function paginate(o) {
    const now = o.now || (() => Date.now());
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const maxPages = Math.max(1, o.maxPages || 20);
    const maxRetries = o.maxRetries == null ? 3 : o.maxRetries;
    const stallLimit = o.stallLimit || 2;
    const seen = new Set(o.seenKeys || []);
    const cursorsSeen = new Set();
    const reviews = [];
    const stats = { pagesFetched: 0, retrieved: 0, unique: 0, duplicates: 0, skippedEmpty: 0, retries: 0, reportedTotal: null };
    let cursor = o.startCursor == null ? null : o.startCursor;
    let stopReason = null, lastError = null, stalls = 0, hasMore = true;

    while (true) {
      if (o.isCancelled && o.isCancelled()) { stopReason = 'cancelled'; break; }
      if (stats.pagesFetched >= maxPages) { stopReason = 'page_cap'; break; }
      if (o.deadlineMs && now() >= o.deadlineMs) { stopReason = 'time_budget'; break; }
      const cursorKey = cursor == null ? '__start__' : String(cursor);
      if (cursorsSeen.has(cursorKey)) { stopReason = 'cursor_loop'; break; }
      cursorsSeen.add(cursorKey);

      let page = null, attempt = 0;
      while (true) {
        try { page = await o.fetchPage(cursor); break; }
        catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError(e && e.name === 'TimeoutError' ? 'timeout' : 'upstream', String((e && e.message) || e));
          lastError = err;
          const canRetry = RETRYABLE.has(err.kind) && attempt < maxRetries;
          const wait = Math.min(err.retryAfterMs || 500 * Math.pow(2, attempt), 8000);
          if (!canRetry || (o.deadlineMs && now() + wait >= o.deadlineMs)) { stopReason = STOP_REASON_FOR[err.kind] || 'upstream_error'; break; }
          attempt++; stats.retries++;
          await sleep(wait);
        }
      }
      if (!page) { cursorsSeen.delete(cursorKey); break; } // cursor can be resumed later
      if (!page || !Array.isArray(page.items)) { stopReason = 'bad_response'; break; }

      stats.pagesFetched++;
      if (page.reportedTotal != null && isFinite(page.reportedTotal)) stats.reportedTotal = Number(page.reportedTotal);
      const normalized = [];
      page.items.forEach((raw, i) => { const r = o.normalize(raw, i); if (r) normalized.push(r); else stats.skippedEmpty++; });
      stats.retrieved += page.items.length;
      const d = dedupe(normalized, seen);
      stats.duplicates += d.duplicates;
      reviews.push(...d.unique);
      stats.unique += d.unique.length;

      hasMore = page.hasMore === true && page.nextCursor != null && page.nextCursor !== '';
      if (!hasMore) { stopReason = 'exhausted'; cursor = null; break; }
      // A page that adds nothing new while claiming more pages is a stall signal.
      stalls = d.unique.length === 0 ? stalls + 1 : 0;
      cursor = page.nextCursor;
      if (stalls >= stallLimit) { stopReason = 'stalled'; break; }
    }

    const resumable = ['page_cap', 'time_budget', 'rate_limited', 'provider_timeout', 'upstream_error', 'cancelled'].includes(stopReason);
    return {
      reviews,
      stats,
      complete: stopReason === 'exhausted',
      stopReason,
      nextCursor: resumable ? cursor : null,
      resumable,
      error: lastError && stopReason !== 'exhausted' ? { kind: lastError.kind, message: lastError.message, status: lastError.status || null, providerCode: lastError.providerCode || null } : null,
      seenKeys: Array.from(seen)
    };
  }

  return { ProviderError, classifyHttp, paginate, dedupe, stableKey, hash };
});
