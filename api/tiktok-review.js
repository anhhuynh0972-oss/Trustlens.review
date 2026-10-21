// TikTok Shop review retrieval via configured SocQ public-review provider, with official Research API fallback.
// Third-party access requires a valid SOCQ_API_KEY and product/region availability is not guaranteed.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SOCQ_API_KEY && !process.env.TIKTOK_RESEARCH_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'No review data provider is configured. Add SOCQ_API_KEY for the third-party public-review provider, or an approved TIKTOK_RESEARCH_ACCESS_TOKEN where eligible.' });
  }
  try {
    const input = req.body && typeof req.body === 'object' ? String(req.body.url || '') : '';
    let url; try { url = new URL(input); } catch { return res.status(400).json({ error: 'Invalid product URL.' }); }
    const host = url.hostname.toLowerCase();
    if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vt.tiktok.com' || host === 'vm.tiktok.com')) return res.status(400).json({ error: 'For URL retrieval, submit a TikTok/TikTok Shop product URL.' });
    let resolved = url;
    if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {
      try { const redirect = await fetch(input, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'TrustLens/1.0' }, signal: AbortSignal.timeout(8000) }); resolved = new URL(redirect.url); }
      catch { return res.status(422).json({ error: 'Could not resolve the short TikTok link. Paste the full product URL instead.' }); }
    }
    const resolvedHost = resolved.hostname.toLowerCase();
    if (!(resolvedHost === 'tiktok.com' || resolvedHost.endsWith('.tiktok.com'))) {
      return res.status(422).json({ error: 'The short link did not resolve to a TikTok page. Copy the product link directly from TikTok Shop and try again.' });
    }
    const pathParts = resolved.pathname.split('/').filter(Boolean);
    const queryId = resolved.searchParams.get('product_id') || resolved.searchParams.get('productId');
    const productId = [queryId, ...pathParts].filter(Boolean).map(x => String(x).match(/\d{8,}/)?.[0]).find(Boolean);
    if (!productId && !process.env.SOCQ_API_KEY) return res.status(422).json({ error: 'Could not identify a product ID in this link. Paste a full TikTok Shop product link, or configure the SocQ provider for supported product URLs.' });

    // SocQ documents public product PDP URLs in /shop/pdp/{id} or /shop/pdp/{slug}/{id} form.
    // Validate this explicitly so unsupported TikTok video/profile URLs are not mistaken for product links.
    if (process.env.SOCQ_API_KEY && !/^\/shop\/pdp\/(?:[^/]+\/)?\d+\/?$/.test(resolved.pathname)) {
      return res.status(422).json({ error: 'This link did not resolve to a supported TikTok Shop product page. The configured provider requires a URL like https://www.tiktok.com/shop/pdp/product-name/1234567890123456789. Open the product in TikTok Shop and copy its product link; video, profile, and some regional share links are not supported by this provider.' });
    }

    // Preferred public-review provider. Requires a separate SocQ API key and may incur usage costs.
    // SocQ uses an asynchronous submit -> poll -> paginate flow; cap polling for serverless runtimes.
    if (process.env.SOCQ_API_KEY) {
      const base = (process.env.SOCQ_BASE_URL || 'https://api.socq.ai').replace(/\/+$/, '');
      const apiRequest = async (path, init = {}) => {
        const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${process.env.SOCQ_API_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(12000) });
        const raw = await r.text(); let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
        if (!r.ok) throw new Error(data.error?.message || data.message || `Review provider returned HTTP ${r.status}`);
        return data;
      };
      const submitted = await apiRequest('/v1/tiktok-shop/product-reviews', { method: 'POST', body: JSON.stringify({ url: resolved.toString(), results_limit: Math.min(500, Math.max(20, Number(process.env.SOCQ_RESULTS_LIMIT || 100))), region: process.env.SOCQ_REGION || 'VN' }) });
      const taskId = submitted?.data?.task_id;
      if (!taskId) throw new Error('Review provider did not return a task ID. Check provider API configuration.');
      const deadline = Date.now() + 26000;
      let task;
      while (Date.now() < deadline) {
        const response = await apiRequest(`/v1/tasks/${encodeURIComponent(taskId)}?limit=100`);
        task = response?.data;
        if (task?.status === 'succeeded') break;
        if (task?.status === 'failed') throw new Error(task.error_message || 'Review collection task failed.');
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (task?.status !== 'succeeded') return res.status(504).json({ error: 'Review collection is still processing. Please retry in a moment; no demo reviews were substituted.' });
      const items = [...(task.results?.items || [])];
      let cursor = task.results?.next_cursor, hasMore = task.results?.has_more === true;
      // Bound pagination to protect serverless execution time; return actual retrieved records only.
      let pageCount = 0;
      while (hasMore && cursor && pageCount < 4) {
        const query = new URLSearchParams({ limit: '100', cursor });
        const page = (await apiRequest(`/v1/tasks/${encodeURIComponent(taskId)}?${query}`))?.data;
        items.push(...(page?.results?.items || [])); cursor = page?.results?.next_cursor; hasMore = page?.results?.has_more === true; pageCount++;
      }
      const seen = new Set();
      const reviews = items.map((r, i) => {
        const text = String(r.review_text || r.text || r.review || r.content || '').trim();
        const rawRating = r.review_rating ?? r.rating;
        const rating = ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 })[String(rawRating || '').toUpperCase()] || Number(rawRating) || null;
        const id = String(r.id || r.review_id || `SOCQ-${i + 1}`);
        return { id, text, rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : null, created_at: r.create_time || r.created_at || null, source_url: r.url || r.review_url || null };
      }).filter(r => r.text && !seen.has(r.id) && seen.add(r.id));
      if (!reviews.length) return res.status(422).json({ error: 'The configured provider returned no review text for this product/region. No sample reviews were substituted.' });
      return res.status(200).json({ source: 'SocQ public-review provider', product: { product_id: productId || null, name: items.find(x => x.product_name)?.product_name || 'TikTok Shop product', url: input, platform: 'TikTok Shop' }, reviews, notice: 'Reviews are from the configured third-party provider. Availability and fields depend on product and region.' });
    }

    const token = process.env.TIKTOK_RESEARCH_ACCESS_TOKEN;
    const base = 'https://open.tiktokapis.com/v2/research/tts/';
    const call = async (resource, fields, body) => {
      const endpoint = new URL(base + resource + '/'); endpoint.searchParams.set('fields', fields);
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || (data.error && data.error.code && data.error.code !== 'ok' && data.error.code !== 0)) throw new Error(data.error?.message || data.error_description || `TikTok API returned HTTP ${r.status}`);
      return data;
    };
    const reviewResp = await call('review', 'product_name,review_text,review_like_count,create_time,review_rating', { product_id: productId, page_start: 1, page_size: 10 });
    const rawReviews = reviewResp.data?.review_data || reviewResp.data?.reviews || [];
    const reviews = rawReviews.map((r, i) => ({ id: `TT-${String(i + 1).padStart(3, '0')}`, text: String(r.review_text || '').trim(), rating: ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 })[String(r.review_rating || '').toUpperCase()] || Number(r.review_rating) || null, created_at: r.create_time || null, likes: r.review_like_count ?? null })).filter(r => r.text);
    if (!reviews.length) return res.status(422).json({ error: 'The official API returned no review text for this product. Its documented review data is limited to eligible EU products; Vietnam links may not be supported. No sample reviews were substituted.' });
    return res.status(200).json({ source: 'TikTok Research API', product: { product_id: productId, name: rawReviews[0]?.product_name || 'TikTok Shop product', url: input, platform: 'TikTok Shop' }, reviews, notice: 'The official Research API is access-controlled and its documented Shop review data covers eligible EU products; availability for Vietnam is not guaranteed.' });
  } catch (e) {
    const message = String(e.message || 'TikTok API request failed').slice(0, 300);
    const isAccess = /scope|permission|access|token|unauthor|forbidden|region|EU|research/i.test(message);
    return res.status(isAccess ? 403 : 502).json({ error: `Review retrieval failed: ${message}. Check provider key, quota, product URL, and region availability. No sample data was used.` });
  }
};
