// POST /api/tiktok-review — retrieve real TikTok Shop reviews through the configured provider.
// One call fetches as many pages as fit in the time budget, then returns a resume token so the browser
// can continue. Never substitutes demo data, never scrapes TikTok directly, never exposes provider keys.
const { normalizeProductUrl, UrlError } = require('../lib/url.js');
const { paginate, ProviderError } = require('../lib/retrieve.js');
const { selectProvider } = require('../lib/providers.js');
const { normalizeReview } = require('../lib/analysis.js');

const CALL_BUDGET_MS = 40000; // Vercel maxDuration is 60 s; leave headroom
const HARD_MAX_PAGES = 200;

// Stop reasons the user can usefully retry later (vs. ones that need a config/URL change).
const RETRYABLE = new Set(['rate_limited', 'provider_timeout', 'upstream_error', 'lookup_failed', 'time_budget', 'provider_processing', 'server_error', 'cancelled', 'bad_response']);

// One safe line per failed/partial retrieval for the Vercel function logs: no keys, URLs or review text.
function logRetrieval(fields) {
  try { console.error('[tiktok-review] ' + JSON.stringify(fields)); } catch (e) { /* never fail on logging */ }
}

function send(res, status, body) {
  if (body && body.stopReason && body.retryable === undefined) body.retryable = RETRYABLE.has(body.stopReason);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}

async function dnsLookup(host) {
  const dns = require('dns').promises;
  return (await dns.lookup(host, { all: true })).map(a => a.address);
}

function parseResume(r, providerName) {
  if (!r || typeof r !== 'object') return null;
  if (r.provider !== providerName) throw new ProviderError('bad_request', 'Resume token belongs to a different provider.');
  const cursor = r.cursor == null ? null : String(r.cursor);
  if (cursor != null && (cursor.length > 512 || /[\u0000-\u001f]/.test(cursor))) throw new ProviderError('bad_request', 'Invalid resume cursor.');
  const taskId = r.taskId == null ? null : String(r.taskId);
  if (taskId != null && !/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw new ProviderError('bad_request', 'Invalid resume task.');
  return { cursor, taskId, started: r.started === true };
}

async function handler(req, res, deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const doFetch = deps.fetch || fetch;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const provider = selectProvider(env, doFetch);
  if (!provider) return send(res, 503, { error: 'provider_not_configured', stopReason: 'provider_not_configured', retryable: false, message: 'No review data provider is configured on the server (SOCIALFETCH_API_KEY or SOCQ_API_KEY). No demo reviews were substituted.' });

  let target;
  try {
    target = await normalizeProductUrl(body.url, { fetch: doFetch, lookup: deps.lookup === undefined ? dnsLookup : deps.lookup });
  } catch (e) {
    if (e instanceof UrlError) return send(res, e.code === 'resolve_failed' ? 422 : 400, { error: 'invalid_url', stopReason: 'invalid_url', retryable: e.code === 'resolve_failed', code: e.code, message: e.message });
    return send(res, 400, { error: 'invalid_url', stopReason: 'invalid_url', retryable: false, code: 'invalid', message: 'Could not read this link.' });
  }

  const maxPagesTotal = Math.min(HARD_MAX_PAGES, Math.max(1, Number(env.REVIEW_MAX_PAGES) || 20));
  const pagesSoFar = Math.max(0, Math.min(HARD_MAX_PAGES, Number(body.pagesSoFar) || 0));
  const remainingPages = maxPagesTotal - pagesSoFar;
  const base = { provider: { name: provider.name, label: provider.label, reportedTotalKind: provider.reportedTotalKind }, product: { productId: target.productId, canonicalUrl: target.canonicalUrl, resolvedFromShortLink: target.wasShortLink } };
  if (remainingPages <= 0) return send(res, 200, { ...base, ok: true, reviews: [], batch: { pagesFetched: 0, retrieved: 0, unique: 0, duplicates: 0 }, complete: false, stopReason: 'page_cap', resume: null, maxPages: maxPagesTotal });

  const deadlineMs = now() + CALL_BUDGET_MS;
  try {
    const resume = parseResume(body.resume, provider.name);
    const ctx = { canonicalUrl: target.canonicalUrl, productId: target.productId };
    const started = await provider.start(ctx, resume, deadlineMs, sleep, now);
    if (!started.ready) {
      // Provider job still running: give the browser a token to continue; nothing fabricated.
      return send(res, 202, { ...base, ok: true, pending: true, reviews: [], batch: { pagesFetched: 0, retrieved: 0, unique: 0, duplicates: 0 }, complete: false, stopReason: 'provider_processing', resume: { provider: provider.name, taskId: started.state.taskId || null, cursor: null }, maxPages: maxPagesTotal });
    }
    let productSummary = null, credits = 0;
    const result = await paginate({
      startCursor: resume ? resume.cursor : null,
      maxPages: remainingPages,
      deadlineMs,
      now, sleep,
      fetchPage: async cursor => {
        const p = await provider.fetchPage(ctx, cursor, started.state);
        if (p.productSummary) productSummary = p.productSummary;
        if (p.credits) credits += p.credits;
        return p;
      },
      normalize: raw => normalizeReview(raw, { source: provider.name, productId: target.productId, prefix: 'NOID' })
    });
    if (!result.complete) logRetrieval({ provider: provider.name, productId: target.productId, stopReason: result.stopReason, pages: result.stats.pagesFetched, unique: result.stats.unique, httpStatus: result.error && result.error.status, providerCode: result.error && result.error.providerCode });
    const status = result.reviews.length || result.complete ? 200 : result.stopReason === 'lookup_failed' ? 502 : (result.stopReason === 'auth_failed' ? 502 : result.stopReason === 'credits_exhausted' ? 402 : result.stopReason === 'not_found' ? 404 : result.stopReason === 'rate_limited' ? 429 : 502);
    return send(res, status, {
      ...base,
      ok: status === 200,
      reviews: result.reviews,
      reportedTotal: result.stats.reportedTotal,
      productSummary,
      creditsCharged: credits || null,
      batch: result.stats,
      complete: result.complete,
      stopReason: result.stopReason,
      error: result.error ? { kind: result.error.kind } : null,
      diagnostic: result.error ? { httpStatus: result.error.status, providerCode: result.error.providerCode } : null,
      resume: result.resumable && result.nextCursor != null ? { provider: provider.name, taskId: started.state.taskId || null, cursor: String(result.nextCursor) } : null,
      maxPages: maxPagesTotal
    });
  } catch (e) {
    const kind = e instanceof ProviderError ? e.kind : 'upstream';
    const map = { auth: [502, 'auth_failed'], credits: [402, 'credits_exhausted'], rate_limited: [429, 'rate_limited'], not_found: [404, 'not_found'], bad_request: [422, 'provider_rejected'], timeout: [504, 'provider_timeout'], lookup_failed: [502, 'lookup_failed'], bad_response: [502, 'bad_response'] };
    const [status, code] = map[kind] || [502, 'upstream_error'];
    logRetrieval({ provider: provider.name, productId: target.productId, stopReason: code, httpStatus: e && e.status, providerCode: e && e.providerCode, unexpected: !(e instanceof ProviderError) ? String(e && e.name) : undefined });
    return send(res, status, { ...base, ok: false, error: code, stopReason: code, message: e instanceof ProviderError ? e.message : 'Review retrieval failed.', diagnostic: { httpStatus: (e && e.status) || null, providerCode: (e && e.providerCode) || null }, reviews: [], complete: false });
  }
}

module.exports = async (req, res) => {
  try { return await handler(req, res); }
  catch (e) {
    logRetrieval({ stopReason: 'server_error', unexpected: String(e && e.name) });
    return send(res, 500, { ok: false, error: 'server_error', stopReason: 'server_error', message: 'Unexpected server error while retrieving reviews.', reviews: [], complete: false });
  }
};
module.exports.handler = handler;
