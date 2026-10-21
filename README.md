# TrustLens — TikTok Shop Review Analyzer (Bilingual + Gemini AI)

TrustLens helps shoppers inspect review evidence before buying. The interface defaults to English and includes a `VI | EN` toggle. When a supported AI request is made, Gemini is asked to interpret the supplied reviews in the currently selected language.

## What is included

- `index.html` — bilingual English/Vietnamese interface.
- `api/analyze.js` — server-side Google Gemini interpretation. It does not expose the API key to the browser. AI observations must cite supplied review IDs; counts are computed locally from the actual review records.
- `api/tiktok-review.js` — server-side review retrieval adapter. It supports the SocQ public-review API and an eligible official TikTok Research API token. It validates the URL format for the SocQ provider and never substitutes demo reviews for a pasted URL.
- `data/` — clearly labeled synthetic demo datasets for presentation/testing only.
- `vercel.json`, `package.json`, `.env.example` — deployment/configuration files.

## Important: a TikTok link + Gemini key is not enough to fetch real reviews

Gemini analyzes review text; it is not the source of TikTok Shop customer reviews. To retrieve real reviews automatically, TrustLens needs an approved data connection. The included TikTok endpoint uses the official TikTok Research API and requires a valid `TIKTOK_RESEARCH_ACCESS_TOKEN` with the `research.data.basic` scope. TikTok's documented review endpoint returns reviews for products available for purchase in the EU; it does not guarantee access to Vietnam TikTok Shop products. If a Vietnam link is unsupported, the app explains the limitation and does not fabricate results.

SocQ's documented product-review endpoint expects a supported TikTok Shop product PDP URL in `/shop/pdp/{id}` or `/shop/pdp/{slug}/{id}` form. Short links work only if they resolve to a supported PDP. Some Vietnam regional share links or older `/view/product/` URLs may not be accepted; the API will show an explicit error instead of pretending the link worked. If a provider returns no reviews, use review text you are authorized to use: paste one review per line or import CSV/JSON. Gemini can then summarize recurring positives, complaints, evidence IDs, limitations, and practical checks before purchase.

Official TikTok documentation: https://developers.tiktok.com/docs/en/research-api-specs-query-tiktok-shop-reviews
Google Gemini API documentation: https://ai.google.dev/api/generate-content

## Deploy to the existing Vercel project

1. Extract this ZIP.
2. Copy **the contents inside this folder** into the root of the existing GitHub repository `anhhuynh0972-oss/trustlens-review-analyzer`, keeping the folder structure. In particular, the root must contain `index.html`, `api/`, `data/`, `package.json`, and `vercel.json`.
3. Confirm `api/analyze.js` and `api/tiktok-review.js` are inside the `api` folder—not beside `index.html`.
4. Commit the changes to GitHub. Vercel should deploy the commit automatically.
5. In Vercel → Project → Settings → Environment Variables, set `GEMINI_API_KEY` for Production (and Preview/Development if needed). Redeploy after changing environment variables.
6. To enable official TikTok retrieval, set `TIKTOK_RESEARCH_ACCESS_TOKEN` only if TikTok has approved your access and scope. A Google Gemini key does not replace this token.
7. Test the pasted-link workflow. If no TikTok token is configured, the endpoint should return a clear error rather than demo reviews.

## Security

- Never paste API keys into `index.html` or commit real secrets to GitHub.
- `.env.example` contains placeholders only. Keep your real `.env` file out of version control.
- Only upload/import review text you are authorized to use; consider privacy before sending text to an AI provider.

## Local development

Use Vercel Functions locally so `/api/*` routes work:

```bash
npx vercel dev
```

`node server.js` serves the basic static/local app but does not reproduce every Vercel serverless route.

## What TrustLens does not claim

- It does not guarantee that arbitrary Vietnam TikTok Shop URLs can be fetched.
- It does not invent customer feedback when a source is unavailable.
- It does not prove a review is fake or a seller is fraudulent. It highlights patterns and evidence that a shopper should inspect.


## Automatic public-review retrieval (optional provider)

TrustLens supports the SocQ TikTok Shop Product Reviews API through the server-side `SOCQ_API_KEY` environment variable. The integration submits the product URL, polls the provider task, and reads available result pages. Provider usage may be paid. Product/region coverage is controlled by the provider; setting `SOCQ_REGION=VN` requests Vietnam but does not guarantee coverage. Never put this key in `index.html` or commit it to GitHub.

Configure these in Vercel Project Settings → Environment Variables, then redeploy:

- `GEMINI_API_KEY` — enables Gemini AI interpretation.
- `SOCQ_API_KEY` — enables the third-party public review provider.
- `SOCQ_REGION` — optional; defaults to `VN`.
- `SOCQ_RESULTS_LIMIT` — optional; defaults to `100`.
- `TIKTOK_RESEARCH_ACCESS_TOKEN` — optional fallback for approved Research API access; official review data has eligibility restrictions and should not be assumed to support Vietnam.

## Deployment verification

`GET /api/health` reports whether the required environment variables are present; it does not expose their values and is not a live provider connectivity check. After deploying, run:

```bash
npm run test:production -- https://YOUR-VERCEL-DOMAIN.vercel.app
```

The smoke test checks the homepage, language-toggle markup, health endpoint, and API method handling. Then run a real provider test with a specific product URL (may consume paid credits): `npm run test:product-link -- https://YOUR-VERCEL-DOMAIN.vercel.app "https://www.tiktok.com/shop/pdp/product-name/1234567890123456789"`. Confirm the result is labeled as provider data, source reviews are displayed, and Gemini analysis works in the browser. If provider coverage or credentials are missing, the app must show an error instead of fabricated reviews. Neither mocked tests nor the health endpoint certify that a specific Vietnam product is supported.
