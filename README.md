# TrustLens — TikTok Shop review credibility assistant

TrustLens helps Vietnamese Gen Z (18–24) shoppers check TikTok Shop reviews before buying. Paste a product link, and TrustLens retrieves the real reviews through a licensed data provider. It analyses them with Google Gemini in batches and shows a summary, findings and potential red flags, each one linked to the original review excerpts and review IDs. The interface is bilingual (VI | EN).

## Site sections

Hero → The Problem → Research & Evidence → How TrustLens Works (with technology stack and live service status) → Survey Insights → Core Features → Demo / Interactive Analysis → Roadmap → Evaluation & Expected Impact → FAQ → Footer & Sources. The analysis dashboard (results computed from the actual reviews only) opens from "Get Started", the demo cards or a product link.

Survey figures come from the group's response spreadsheet, "TikTok Shop & Gen Z Consumer Behaviour" (61 responses, 10–14 Oct 2026), and were recomputed from the raw answers: Q10 43/61, Q9 29/61, Q11 31/61, Q9 25/61, Q9 24/61. The problem, roadmap and evaluation wording follows the group poster.

## The six-step workflow (dashboard)

1. **Submit**: a TikTok Shop product link, or reviews pasted or imported from CSV/JSON.
2. **Retrieve**: the provider is paged with de-duplication; the page shows real progress and a complete/partial status. For pasted reviews this step is skipped.
3. **Classify sentiment**: Gemini labels every review positive, neutral or negative, in batches. Percentages are computed by TrustLens.
4. **Themes, complaints and red flags**: Gemini findings are merged across batches with counted supporting reviews and original excerpts, plus rule-based checks.
5. **Structured report**: real statistics, findings with excerpts and IDs, and limitations. It can be copied or downloaded as .txt.
6. **Decision summary**: an evidence label computed by a published counting rule (not by the AI), the strengths, complaints and points to check, and what the data cannot tell you. Gemini only explains that label; it never says "buy" or "don't buy".

A tracker shows each step's real state. Demo products never call the API and stay rule-based.

`GET /api/health?check=ai` verifies the Gemini key and model with Google's free model lookup. When AI fails, the API returns a specific code: `ai_auth`, `ai_model_unavailable`, `ai_rate_limited`, `ai_timeout` or `ai_invalid_output`.

## Structure

The layout is deliberately flat: GitHub's web uploader drops folders, so every public file lives in the repository root. Only `api/` (the Vercel functions) is a folder; upload its three files from inside the `api` folder on GitHub.

| Path | Purpose |
|---|---|
| `index.html` | The site: landing page, research section, demo products and analysis dashboard. Includes the rule-based browser engine and the existing `data-i18n` VI/EN system. |
| `live.js` | Live retrieval flow (progress, cancel, continue, retry), batched AI analysis, evidence rendering, CSV/JSON import. |
| `liquid-hero.js` | WebGL2 liquid-particle hero artwork (ported from a React component by guglielmogiannattasio.it). The static image shows without WebGL2 or with reduced motion. |
| `motion.js` | Scroll reveals, count-ups, active nav, progress bar. |
| `hero-art.jpg` | Hero artwork (cropped from the group's TrustLens visual). |
| `i18n-extra.js` | VI/EN strings for the research section and live/AI UI, added to the existing dictionaries. |
| `url.js` | URL validation, product-ID extraction, and short-link resolution (TikTok hosts only, private IPs blocked). |
| `retrieve.js` | Pagination engine: page cap, loop and stall protection, de-duplication, retries, partial results, resume. |
| `providers.js` | Social Fetch and SocQ adapters, following each provider's documented API. |
| `analysis.js` | Review normalisation, batching, AI output validation, merging, data signals. |
| `api/tiktok-review.js` | `POST` endpoint that retrieves reviews (server-side keys). |
| `api/analyze.js` | `POST` endpoint for Gemini analysis (`mode: "batch"` or `"summary"`). |
| `api/health.js` | `GET` endpoint reporting which settings are configured. Returns booleans only. |
| `*.json` (demo) | Synthetic demo datasets, labelled as synthetic. |
| `tests/` | Automated tests (`npm test` runs them in Node; `tests/browser.html` runs everything, UI tests included, in a browser). |

## Environment variables (Vercel → Project → Settings → Environment Variables → Production, then **Redeploy**)

| Name | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes, for AI | Google AI Studio key. Without it, only rule-based checks run, and the page says so. |
| `SOCIALFETCH_API_KEY` | one provider is required | Social Fetch (`x-api-key`). Documents `region=VN`. Costs 1 credit per page of reviews. |
| `SOCQ_API_KEY` | alternative provider | SocQ (Bearer). Async tasks, billed per saved review. VN coverage is not documented. |
| `REVIEW_PROVIDER` | optional | `socialfetch` or `socq`. Picks one when both keys are set. |
| `REVIEW_REGION` | optional | Default `VN`. |
| `REVIEW_MAX_PAGES` | optional | Safe page cap per product. Default 20, hard maximum 200. Use 2 for the first live test. |
| `SOCQ_RESULTS_LIMIT` | optional | SocQ only. 20–2000, default 500. |
| `GEMINI_MODEL` | optional | Default `gemini-2.5-flash`. |

Keys never reach the browser. `.env.example` contains placeholders only. Keep your `.env` out of git; `.gitignore` already excludes it.

## Honesty rules built into the code

- Demo data is never substituted for live data. Without a configured provider, the endpoint returns `503 provider_not_configured`.
- A result is marked "complete" only when the provider's pagination reports there are no more pages. Otherwise it is "partial", with the stop reason: page cap, rate limit, credits exhausted, stall or loop, timeout, or user cancellation.
- Counts come from the actual records. The figure "reported by source" is the provider's own number: the product's total for Social Fetch, the collected count for SocQ.
- AI coverage is shown as analysed/retrieved. Batches that fail are reported, and can be retried.
- AI output is schema-validated. Any review ID the model cites that wasn't in the batch is dropped. Counts are computed from real IDs, never by the model.
- Seller indicators use only fields the source returns. There is no invented trust score.

## Tests

```bash
npm test
```

This runs in Node 18+. Tests marked `[mock]` use mocked provider and AI responses. They prove the logic, not that live data is available. Open `tests/browser.html` through any static server to also run the UI tests: language toggle, progress states, and no overflow at 360 px. After deploying:

```bash
npm run test:production -- https://YOUR-DOMAIN.vercel.app
```

The live test (real provider; uses credits) should start with `REVIEW_MAX_PAGES=2`:

```bash
npm run test:live -- https://YOUR-DOMAIN.vercel.app "https://www.tiktok.com/shop/pdp/<slug>/<product-id>"
```

## Local development

`node server.js` serves the site and the same `/api/*` handlers. It reads `.env` if present and serves only public files.
