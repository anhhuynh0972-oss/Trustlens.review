# TrustLens — Poster-aligned MVP

This version follows the poster's stated concept and core features:
1. AI Review Summary
2. Seller Credibility Indicators
3. Potential Red-Flag Alerts
4. Key Information Highlights

It also includes the six-step workflow (Select → Analyse → Identify → Summarise → Evaluate → Decide) and the proposed stack (AI & NLP, Data Analytics, Transparency Signals).

## Important source/data limitation
- Sample datasets are synthetic and only for demo mode. They are explicitly labeled as synthetic.
- A real TikTok Shop URL does not fall back to sample data.
- TikTok Research API requires approved access (`research.data.basic`) and its documented Shop review records cover products available for purchase in the EU; Vietnam availability is not guaranteed.
- Product image, price and seller data are shown only if the configured source actually returns them. The current review endpoint may return only product name and review fields.
- `GEMINI_API_KEY` enables server-side AI interpretation. Without it, analysis uses transparent local heuristics and should not be described as full AI analysis.

## Deploy
Upload the contents of this folder to the root of the existing GitHub repository, keeping `api/`, `data/`, `index.html`, `vercel.json`, and `package.json` at repository root. Configure environment variables in Vercel, then redeploy. See `VERCEL_DEPLOY.md`.
