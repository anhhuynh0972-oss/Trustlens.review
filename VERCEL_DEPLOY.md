# Deploy TrustLens (English default + VI | EN + Gemini)

1. Extract the ZIP.
2. Upload/commit the **contents** to the root of `anhhuynh0972-oss/trustlens-review-analyzer`.
3. Keep `api/analyze.js` and `api/tiktok-review.js` inside the `api/` folder; keep sample JSON files in `data/`.
4. In Vercel → Settings → Environment Variables, add `GEMINI_API_KEY`. The key is used only by the serverless function. Redeploy.
5. For real automatic TikTok reviews, you must also have approved TikTok Research API access and a valid `TIKTOK_RESEARCH_ACCESS_TOKEN` with `research.data.basic`. This official endpoint documents review data for eligible EU products; Vietnam products may not be available.
6. Test in English and Vietnamese. Choose the language before running analysis so Gemini generates the interpretation in that language.

If automatic retrieval is unavailable, paste/import review records you are authorized to use. Gemini interprets the provided text; it does not fetch reviews from a TikTok link by itself.


## Extra configuration for public review retrieval

For third-party public-review retrieval, obtain a SocQ API key and add `SOCQ_API_KEY` in Vercel Environment Variables. Optionally set `SOCQ_REGION=VN` and `SOCQ_RESULTS_LIMIT=100`. This may be a paid provider; check the provider's current terms, pricing, and coverage before use. Keep the key server-side only. The official TikTok Research API token is separate and requires approved access.

After redeploy, visit `/api/health` to confirm configuration flags, then run the production smoke test from a local terminal with `npm run test:production -- https://YOUR-VERCEL-DOMAIN.vercel.app`. Finally, manually test a real product URL; a health check alone cannot verify product-specific data availability.
