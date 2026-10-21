// Tiny dependency-free test harness that runs the same test files in Node (`npm test`) and in a
// browser (tests/browser.html). Tests tagged { mock: true } use a mocked provider/AI, never live data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL_test = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const tests = [];
  function test(name, fn, opts) { tests.push({ name, fn, opts: opts || {} }); }
  const assert = {
    ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v)); },
    equal(a, b, msg) { if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); },
    deepEqual(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((msg ? msg + ': ' : '') + 'expected ' + y + ', got ' + x); },
    match(s, re, msg) { if (!re.test(String(s))) throw new Error((msg ? msg + ': ' : '') + JSON.stringify(String(s).slice(0, 200)) + ' does not match ' + re); },
    async rejects(p, check, msg) {
      let threw = false;
      try { await (typeof p === 'function' ? p() : p); } catch (e) { threw = true; if (check) check(e); }
      if (!threw) throw new Error(msg || 'expected rejection');
    }
  };
  async function run(filter, onResult) {
    const results = [];
    for (const t of tests) {
      if (filter && !filter(t)) { const r = { name: t.name, status: 'skipped', mock: !!t.opts.mock, reason: t.opts.env ? 'needs ' + t.opts.env : 'filtered' }; results.push(r); if (onResult) onResult(r); continue; }
      const start = Date.now();
      try { await t.fn(assert); const r = { name: t.name, status: 'passed', mock: !!t.opts.mock, ms: Date.now() - start }; results.push(r); if (onResult) onResult(r); }
      catch (e) { const r = { name: t.name, status: 'failed', mock: !!t.opts.mock, error: String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ') }; results.push(r); if (onResult) onResult(r); }
    }
    return results;
  }
  // Minimal Vercel-like response object for calling handlers directly.
  function mockRes() {
    return { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  }
  // JSON fetch-response stub.
  function jsonResponse(status, body, headers) {
    const h = Object.assign({}, headers || {});
    return { ok: status >= 200 && status < 300, status, headers: { get: k => h[k.toLowerCase()] ?? null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => typeof body === 'string' ? JSON.parse(body) : body };
  }
  return { test, run, assert, tests, mockRes, jsonResponse };
});
