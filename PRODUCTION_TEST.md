# TrustLens production verification checklist

## 1. Configure secrets in Vercel

In Project Settings → Environment Variables, set:

- `GEMINI_API_KEY` — required for Gemini analysis.
- `SOCQ_API_KEY` — required for the third-party TikTok Shop public-review provider.
- `SOCQ_REGION=VN` — requests Vietnam data where supported.
- `SOCQ_RESULTS_LIMIT=100` — optional.

Do not add real secrets to GitHub or to `index.html`. Redeploy after changing environment variables.

## 2. Configuration health check

Open `https://YOUR-DEPLOYMENT.vercel.app/api/health`. Expect JSON with `ok: true`, booleans for `providers.gemini` and `providers.socq`, and no secret values. A true boolean only means a key exists; it does not prove that the key is valid or that the provider supports a specific product.

## 3. Automated production smoke test

Run locally from the project folder:

```bash
npm run test:production -- https://YOUR-DEPLOYMENT.vercel.app
```

The script checks that the homepage loads, the language toggle is in the served HTML, the health endpoint responds, and the two API routes reject GET safely. It does not make paid provider calls.

## 4. End-to-end real product test

After smoke tests pass, open the deployed site, paste a real public TikTok Shop Vietnam product link, and click Analyse Reviews. Verify:

- the result reports the configured provider as the source;
- displayed review text is returned by the provider, not a demo fixture;
- review counts and rating values are derived from returned records;
- Gemini summary/concerns cite IDs from the returned reviews;
- changing VI/EN changes the language used for subsequent AI analysis;
- an unsupported URL, missing API key, provider error, or zero-review result is shown as an error and never replaced with sample data.

Keep a copy of the product URL, time, and non-sensitive error message for troubleshooting. Never share API keys in screenshots or chat.


## 5. Automated real product-link test (calls the configured provider)

This test sends the supplied product URL through the deployed TrustLens API. It can consume paid SocQ credits and must use a public product URL you are authorized to test. Use a full supported PDP URL such as `https://www.tiktok.com/shop/pdp/product-name/1234567890123456789`; short links work only if they redirect to a supported product page.

```bash
npm run test:product-link -- https://YOUR-DEPLOYMENT.vercel.app "https://www.tiktok.com/shop/pdp/product-name/1234567890123456789"
```

A pass means the provider returned non-empty review text for that specific URL at test time. It does not mean every Vietnam product link is supported. A failure prints the actual HTTP/error message; do not treat mocked unit tests as a real provider test.
