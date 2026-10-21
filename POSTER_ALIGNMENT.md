# TrustLens — Poster-aligned MVP

This version follows the poster's stated concept and core features:
1. AI Review Summary
2. Seller Credibility Indicators
3. Potential Red-Flag Alerts
4. Key Information Highlights

It also includes the six-step workflow (Select → Analyse → Identify → Summarise → Evaluate → Decide) and the proposed stack (AI & NLP, Data Analytics, Transparency Signals).

## Data sources
- Product links: real reviews via the configured provider (Social Fetch or SocQ), retrieved server-side with pagination, de-duplication and honest complete/partial status. Never replaced with demo data.
- Demo products and the three synthetic datasets in `data/` are labelled as demo/synthetic.
- Seller indicators appear only for fields the source returns; no invented trust score.
- See README.md for setup, environment variables and deployment.
