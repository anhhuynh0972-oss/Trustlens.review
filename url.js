// TikTok Shop product URL validation, product-ID extraction and safe short-link resolution.
// Shared by the serverless API (CommonJS) and the browser test runner (global TL_url).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL_url = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Only these hosts are ever contacted while resolving a pasted link.
  const SHORT_LINK_HOSTS = ['vt.tiktok.com', 'vm.tiktok.com'];
  const PRODUCT_HOSTS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'shop.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'];
  const MAX_URL_LENGTH = 2048;
  const MAX_REDIRECTS = 5;

  class UrlError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  function isAllowedHost(host) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    return PRODUCT_HOSTS.includes(host) || /^[a-z0-9-]+\.tiktok\.com$/.test(host);
  }

  function isIpLiteral(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);
  }

  // Private, loopback, link-local, CGNAT and other non-public ranges (IPv4 and IPv6).
  function isPrivateIp(ip) {
    ip = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  }

  // Parse and validate user input. Does not perform any network access.
  function parseProductUrl(input) {
    let raw = String(input == null ? '' : input).trim();
    if (!raw) throw new UrlError('empty', 'Paste a TikTok Shop product link.');
    if (raw.length > MAX_URL_LENGTH) throw new UrlError('too_long', 'The link is too long.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
    let url;
    try { url = new URL(raw); } catch (e) { throw new UrlError('invalid', 'This is not a valid URL.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlError('scheme', 'Only http(s) links are accepted.');
    if (url.username || url.password) throw new UrlError('credentials', 'Links containing credentials are not accepted.');
    if (url.port && url.port !== '443' && url.port !== '80') throw new UrlError('port', 'Links with a custom port are not accepted.');
    const host = url.hostname.toLowerCase();
    if (isIpLiteral(host)) throw new UrlError('ip_host', 'IP-address links are not accepted.');
    if (!isAllowedHost(host)) throw new UrlError('host', 'Only TikTok / TikTok Shop product links are accepted.');
    url.protocol = 'https:';
    url.port = '';
    url.hash = '';
    return { url, isShortLink: SHORT_LINK_HOSTS.includes(host) };
  }

  // Product IDs on TikTok Shop are long numeric strings (typically 16–19 digits).
  function extractProductId(url) {
    const u = typeof url === 'string' ? new URL(url) : url;
    for (const key of ['product_id', 'productId', 'pid']) {
      const v = u.searchParams.get(key);
      if (v && /^\d{10,20}$/.test(v)) return v;
    }
    const path = u.pathname.replace(/\/+$/, '');
    const patterns = [
      /^\/shop\/pdp\/(?:[^/]+\/)?(\d{10,20})$/,
      /^\/view\/product\/(\d{10,20})$/,
      /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?shop\/(?:[a-z]{2}\/)?pdp\/(?:[^/]+\/)?(\d{10,20})$/i,
      // regional shop links, e.g. shop.tiktok.com/vn/pdp/<slug>/<id> or shop.tiktok.com/pdp/<id>
      /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?pdp\/(?:[^/]+\/)?(\d{10,20})$/i,
      /^\/product\/(\d{10,20})$/
    ];
    for (const re of patterns) { const m = path.match(re); if (m) return m[1]; }
    return null;
  }

  // Canonical PDP URL accepted by review providers.
  function canonicalProductUrl(productId) {
    return 'https://www.tiktok.com/shop/pdp/' + productId;
  }

  // Resolve a vt./vm.tiktok.com short link hop by hop. Every hop must stay on an allowed
  // TikTok host over https and resolve to a public IP. `deps.fetch` / `deps.lookup` are injectable for tests.
  async function resolveShortLink(url, deps) {
    deps = deps || {};
    const doFetch = deps.fetch || fetch;
    const lookup = deps.lookup;
    let current = new URL(url.toString());
    const visited = new Set();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (visited.has(current.href)) throw new UrlError('redirect_loop', 'The short link redirects in a loop.');
      visited.add(current.href);
      if (current.protocol !== 'https:' || !isAllowedHost(current.hostname) || isIpLiteral(current.hostname)) {
        throw new UrlError('redirect_host', 'The short link redirected outside TikTok, so it was not followed.');
      }
      if (lookup) {
        const addrs = await lookup(current.hostname);
        if (!addrs.length || addrs.some(isPrivateIp)) throw new UrlError('private_ip', 'The link resolved to a non-public network address.');
      }
      if (!SHORT_LINK_HOSTS.includes(current.hostname.toLowerCase())) return current; // reached a product host
      let res;
      try {
        res = await doFetch(current.href, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'TrustLens/2.0 (+link-resolver)' }, signal: timeoutSignal(8000) });
      } catch (e) {
        throw new UrlError('resolve_failed', 'Could not resolve the short link. Paste the full product link instead.');
      }
      const loc = res.headers && (typeof res.headers.get === 'function' ? res.headers.get('location') : res.headers.location);
      if (res.status < 300 || res.status >= 400 || !loc) throw new UrlError('resolve_failed', 'The short link did not redirect to a product page.');
      current = new URL(loc, current);
    }
    throw new UrlError('too_many_redirects', 'The short link redirected too many times.');
  }

  function timeoutSignal(ms) {
    return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;
  }

  // Full pipeline: validate → resolve short link (if any) → extract product ID.
  async function normalizeProductUrl(input, deps) {
    const parsed = parseProductUrl(input);
    let resolved = parsed.url;
    if (parsed.isShortLink) resolved = await resolveShortLink(parsed.url, deps);
    const productId = extractProductId(resolved);
    if (!productId) throw new UrlError('no_product_id', 'Could not find a TikTok Shop product ID in this link. Open the product in TikTok Shop and copy its product link.');
    return { inputUrl: parsed.url.href, resolvedUrl: resolved.href, productId, canonicalUrl: canonicalProductUrl(productId), wasShortLink: parsed.isShortLink };
  }

  return { UrlError, parseProductUrl, extractProductId, resolveShortLink, normalizeProductUrl, canonicalProductUrl, isAllowedHost, isPrivateIp, SHORT_LINK_HOSTS };
});
