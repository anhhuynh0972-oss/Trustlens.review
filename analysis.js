// Review normalization, AI batching, structured-output validation, batch merging and
// deterministic data signals. Shared by the API (CommonJS) and the browser (global TL_analysis).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL_analysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = ['quality', 'durability', 'performance', 'battery_charging', 'size_fit', 'appearance_vs_listing', 'authenticity', 'delivery', 'packaging', 'seller_service', 'price_value', 'usability', 'safety', 'other'];
  const MAX_TEXT = 2000;

  function toRating(v) {
    if (v == null || v === '') return null;
    const words = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    const n = words[String(v).toUpperCase()] || Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n * 10) / 10 : null;
  }
  function toDate(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function toBool(v) {
    if (v === true || v === false) return v;
    if (v == null || v === '') return null;
    const s = String(v).toLowerCase();
    return ['true', '1', 'yes', 'verified'].includes(s) ? true : ['false', '0', 'no'].includes(s) ? false : null;
  }
  function safeHttpUrl(v) {
    try { const u = new URL(String(v)); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null; } catch (e) { return null; }
  }

  // Normalize one raw record (provider item, CSV row or JSON object) to the TrustLens schema.
  // Returns null when there is no usable text. Never invents values: missing fields stay null.
  function normalizeReview(raw, ctx) {
    ctx = ctx || {};
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.review_text ?? raw.text ?? raw.review ?? raw.content ?? raw.comment ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const providerId = raw.review_id ?? raw.reviewId ?? raw.id ?? null;
    // Media shapes: SocQ [{type,url}], Social Fetch {displayImageUrl, imageUrls[]}, CSV/JSON string arrays.
    let mediaRaw = raw.media ?? raw.images ?? raw.review_images ?? raw.image_urls ?? [];
    if (mediaRaw && !Array.isArray(mediaRaw) && typeof mediaRaw === 'object') mediaRaw = mediaRaw.imageUrls || (mediaRaw.displayImageUrl ? [mediaRaw.displayImageUrl] : []);
    const media = (Array.isArray(mediaRaw) ? mediaRaw : [mediaRaw])
      .map(m => safeHttpUrl(typeof m === 'string' ? m : (m && (m.url || m.image_url || m.src))))
      .filter(Boolean).slice(0, 10);
    const who = raw.reviewer || raw.author;
    const authorName = who && typeof who === 'object' ? (who.name || who.username || null) : (who ?? raw.reviewer_name ?? raw.user_name ?? null);
    const review = {
      reviewId: providerId != null && String(providerId).trim() ? String(providerId).trim().slice(0, 100) : null,
      idDerived: false,
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
      rating: toRating(raw.review_rating ?? raw.rating ?? raw.star ?? raw.stars),
      date: toDate(raw.published_at ?? raw.createdAt ?? raw.review_time ?? raw.create_time ?? raw.created_at ?? raw.date ?? raw.time),
      verifiedPurchase: toBool(raw.verifiedPurchase ?? raw.verified_purchase ?? raw.is_verified_purchase),
      incentivized: toBool(raw.incentivized),
      productId: (v => v == null ? null : String(v))(raw.productId ?? raw.product_id ?? raw.subject_id ?? ctx.productId),
      source: ctx.source || 'unknown',
      sourceUrl: safeHttpUrl(raw.url || raw.review_url || raw.source_url),
      media,
      author: authorName ? String(authorName).slice(0, 80) : null,
      sku: raw.variant ?? raw.sku_specification ?? raw.sku ?? null
    };
    if (!review.reviewId) {
      // No platform ID supplied: derive a stable, clearly-labelled local ID from the content.
      review.reviewId = (ctx.prefix || 'LOCAL') + '-' + simpleHash([review.text, review.rating, review.date, review.author].join('|'));
      review.idDerived = true;
    }
    return review;
  }
  function simpleHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36).toUpperCase().padStart(7, '0');
  }

  // Split reviews into batches bounded by both count and characters, so every review is analysed.
  function makeBatches(reviews, opts) {
    opts = opts || {};
    const maxCount = opts.maxCount || 80, maxChars = opts.maxChars || 40000;
    const batches = []; let cur = [], chars = 0;
    for (const r of reviews) {
      const len = r.text.length + 40;
      if (cur.length && (cur.length >= maxCount || chars + len > maxChars)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(r); chars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // JSON schema for Gemini structured output (per batch).
  const BATCH_SCHEMA = {
    type: 'OBJECT',
    properties: {
      findings: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            kind: { type: 'STRING', enum: ['positive', 'negative', 'concern'] },
            category: { type: 'STRING', enum: CATEGORIES },
            title: { type: 'STRING' },
            rationale: { type: 'STRING' },
            review_ids: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['kind', 'category', 'title', 'review_ids']
        }
      },
      sentiment: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, label: { type: 'STRING', enum: ['positive', 'neutral', 'negative'] } }, required: ['id', 'label'] }
      }
    },
    required: ['findings', 'sentiment']
  };

  // Validate one batch result against the reviews actually sent. Drops any ID that was not in the
  // batch; throws when the shape is wrong so the caller can retry.
  function validateBatchResult(ai, batchIds) {
    if (!ai || typeof ai !== 'object' || !Array.isArray(ai.findings) || !Array.isArray(ai.sentiment)) throw new Error('schema');
    const ids = new Set(batchIds);
    const findings = [];
    for (const f of ai.findings) {
      if (!f || typeof f !== 'object') continue;
      const kind = ['positive', 'negative', 'concern'].includes(f.kind) ? f.kind : null;
      const category = CATEGORIES.includes(f.category) ? f.category : 'other';
      const reviewIds = Array.isArray(f.review_ids) ? [...new Set(f.review_ids.map(String).filter(id => ids.has(id)))] : [];
      const title = String(f.title || '').trim().slice(0, 160);
      if (!kind || !title || !reviewIds.length) continue;
      findings.push({ kind, category, title, rationale: String(f.rationale || '').trim().slice(0, 500), reviewIds });
    }
    const sentiment = {};
    for (const s of ai.sentiment) {
      if (s && ids.has(String(s.id)) && ['positive', 'neutral', 'negative'].includes(s.label)) sentiment[String(s.id)] = s.label;
    }
    return { findings, sentiment };
  }

  // Merge validated batch results: group by (kind, category), union supporting IDs.
  // Counts are the number of distinct supporting reviews, computed here — never by the model.
  function mergeBatchResults(results, reviews) {
    const byId = new Map(reviews.map(r => [r.reviewId, r]));
    const groups = new Map();
    const sentiment = {};
    for (const res of results) {
      Object.assign(sentiment, res.sentiment || {});
      for (const f of res.findings || []) {
        const key = f.kind + '|' + f.category;
        if (!groups.has(key)) groups.set(key, { kind: f.kind, category: f.category, titles: new Map(), rationales: [], ids: new Set() });
        const g = groups.get(key);
        g.titles.set(f.title, (g.titles.get(f.title) || 0) + f.reviewIds.length);
        if (f.rationale) g.rationales.push(f.rationale);
        f.reviewIds.forEach(id => { if (byId.has(id)) g.ids.add(id); });
      }
    }
    const findings = [];
    for (const g of groups.values()) {
      if (!g.ids.size) continue;
      const title = [...g.titles.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const ids = [...g.ids];
      findings.push({
        kind: g.kind, category: g.category, title,
        rationale: g.rationales[0] || '',
        count: ids.length,
        reviewIds: ids,
        excerpts: ids.slice(0, 3).map(id => { const r = byId.get(id); return { reviewId: id, idDerived: r.idDerived, text: excerpt(r.text), rating: r.rating }; })
      });
    }
    findings.sort((a, b) => b.count - a.count);
    const counts = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
    reviews.forEach(r => { const s = sentiment[r.reviewId]; counts[s || 'unclassified']++; });
    return { findings, sentiment, sentimentCounts: counts };
  }

  function excerpt(text, max) {
    max = max || 280;
    return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }

  // Deterministic, data-derived signals (no AI). Worded as things to check, never as proof.
  function dataSignals(reviews) {
    const signals = [];
    const n = reviews.length;
    if (!n) return signals;
    // 1. Identical text posted under different review IDs.
    const byText = new Map();
    reviews.forEach(r => {
      const k = r.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (k.length < 12) return;
      if (!byText.has(k)) byText.set(k, []);
      byText.get(k).push(r);
    });
    const dupGroups = [...byText.values()].filter(g => g.length > 1);
    if (dupGroups.length) {
      const ids = dupGroups.flat().map(r => r.reviewId);
      signals.push({ type: 'duplicate_text', count: ids.length, groups: dupGroups.length, reviewIds: ids, excerpts: dupGroups.slice(0, 3).map(g => ({ reviewId: g[0].reviewId, idDerived: g[0].idDerived, text: excerpt(g[0].text), rating: g[0].rating, alsoIds: g.slice(1).map(r => r.reviewId) })) });
    }
    // 2. Many reviews on a single calendar day (only when dates exist).
    const dated = reviews.filter(r => r.date);
    if (dated.length >= 20) {
      const perDay = new Map();
      dated.forEach(r => { const d = r.date.slice(0, 10); perDay.set(d, (perDay.get(d) || []).concat(r)); });
      const [day, list] = [...perDay.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (list.length >= 10 && list.length / dated.length >= 0.3) {
        signals.push({ type: 'date_burst', day, count: list.length, of: dated.length, reviewIds: list.map(r => r.reviewId), excerpts: list.slice(0, 2).map(r => ({ reviewId: r.reviewId, idDerived: r.idDerived, text: excerpt(r.text), rating: r.rating })) });
      }
    }
    // 3. High share of very short 5-star reviews.
    const rated = reviews.filter(r => r.rating != null);
    const shortFive = rated.filter(r => r.rating >= 5 && r.text.length < 15);
    if (rated.length >= 20 && shortFive.length / rated.length >= 0.4) {
      signals.push({ type: 'short_five_star', count: shortFive.length, of: rated.length, reviewIds: shortFive.map(r => r.reviewId), excerpts: shortFive.slice(0, 3).map(r => ({ reviewId: r.reviewId, idDerived: r.idDerived, text: r.text, rating: r.rating })) });
    }
    return signals;
  }

  function ratingStats(reviews) {
    const rated = reviews.filter(r => r.rating != null);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    rated.forEach(r => { dist[Math.min(5, Math.max(1, Math.round(r.rating)))]++; });
    return { count: rated.length, average: rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null, distribution: dist,
      verifiedCount: reviews.filter(r => r.verifiedPurchase === true).length, verifiedKnown: reviews.filter(r => r.verifiedPurchase != null).length,
      withMedia: reviews.filter(r => r.media && r.media.length).length };
  }

  // Step 6: evidence basis for a purchasing decision, computed only from counted data (never by the model).
  // stance: insufficient_evidence | mostly_positive | mixed | mostly_negative
  function decisionBasis(merged, reviews, ctx) {
    ctx = ctx || {};
    const c = merged.sentimentCounts;
    const classified = c.positive + c.neutral + c.negative;
    const retrieved = ctx.retrieved != null ? ctx.retrieved : reviews.length;
    const share = k => classified ? c[k] / classified : 0;
    const big = f => f.count >= Math.max(3, Math.ceil(classified * 0.1));
    const positives = merged.findings.filter(f => f.kind === 'positive').slice(0, 3);
    const complaints = merged.findings.filter(f => f.kind === 'negative').slice(0, 3);
    const concerns = merged.findings.filter(f => f.kind === 'concern');
    const majorConcerns = concerns.filter(big);
    let stance;
    if (classified < 10 || (retrieved && classified / retrieved < 0.5)) stance = 'insufficient_evidence';
    else if (share('negative') >= 0.4) stance = 'mostly_negative';
    else if (share('positive') >= 0.7 && !majorConcerns.length && !complaints.some(big)) stance = 'mostly_positive';
    else stance = 'mixed';
    const unknowns = [];
    if (ctx.complete === false) unknowns.push('partial_retrieval');
    if (retrieved && classified < retrieved) unknowns.push('partial_ai');
    if (!ctx.sellerData) unknowns.push('no_seller');
    if (classified < 30) unknowns.push('small_sample');
    if (!reviews.some(r => r.verifiedPurchase != null)) unknowns.push('no_verified');
    return {
      stance, classified, retrieved,
      counts: { positive: c.positive, neutral: c.neutral, negative: c.negative },
      shares: { positive: share('positive'), neutral: share('neutral'), negative: share('negative') },
      positives, complaints, concerns, majorConcerns, unknowns,
      certainty: certaintyLevel(classified, retrieved, ctx.complete),
      rule: 'insufficient if <10 classified or <50% of retrieved; mostly_negative if negative ≥40%; mostly_positive if positive ≥70% with no complaint/concern backed by ≥max(3,10%) reviews; otherwise mixed'
    };
  }

  // Credibility signals from the reviews themselves (no score, no seller data invented).
  // Each value is a plain ratio with its numerator/denominator so the UI can show how it was computed.
  function credibilitySignals(merged, reviews) {
    const c = merged.sentimentCounts;
    const classified = c.positive + c.neutral + c.negative;
    const ratio = (k, n) => ({ k, n, share: n ? k / n : null });
    const majority = ['positive', 'neutral', 'negative'].reduce((m, k) => c[k] > c[m] ? k : m, 'positive');
    const complaints = merged.findings.filter(f => f.kind === 'negative' || f.kind === 'concern');
    const top = complaints[0] || null;
    const reviewsWithComplaint = new Set(complaints.flatMap(f => f.reviewIds)).size;
    // Rating/text agreement: star rating vs Gemini label, only where both exist.
    let agree = 0, both = 0;
    reviews.forEach(r => {
      const l = merged.sentiment[r.reviewId];
      if (!l || r.rating == null) return;
      both++;
      if ((r.rating >= 4 && l === 'positive') || (r.rating <= 2 && l === 'negative') || (r.rating === 3 && l === 'neutral')) agree++;
    });
    return {
      classified,
      consistency: Object.assign(ratio(c[majority], classified), { majority }),
      complaintReach: ratio(reviewsWithComplaint, classified),
      topComplaint: top ? Object.assign(ratio(top.count, classified), { title: top.title, category: top.category }) : null,
      polarityGap: classified ? (c.positive - c.negative) / classified : null,
      ratingAgreement: ratio(agree, both)
    };
  }

  // Certainty of the conclusions, from data volume and coverage only (documented rule):
  // high: ≥100 classified, retrieval complete, every review classified; medium: ≥30 classified and ≥80% coverage; else low.
  function certaintyLevel(classified, retrieved, complete) {
    const cov = retrieved ? classified / retrieved : 0;
    if (classified >= 100 && complete !== false && cov >= 1) return 'high';
    if (classified >= 30 && cov >= 0.8) return 'medium';
    return 'low';
  }

  return { credibilitySignals, certaintyLevel, decisionBasis, CATEGORIES, BATCH_SCHEMA, normalizeReview, makeBatches, validateBatchResult, mergeBatchResults, dataSignals, ratingStats, excerpt, toRating, toDate };
});
