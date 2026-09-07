# CRO survey endpoint, deploy notes (2026-09-06)

Function: `netlify/functions/cro-survey.mjs`. Storage: Netlify Blobs store `cro-survey`, one JSON per response, key `YYYY-MM-DD/<received_ts>-<rand>.json`.

## Before first deploy

1. Add the Blobs client to `package.json` dependencies (Netlify installs it at build):
   `"dependencies": { "@netlify/blobs": "^8.1.0" }`
   Blobs needs no extra env vars on Netlify-hosted functions (site ID and token are injected).
2. `netlify.toml` currently sets `Access-Control-Allow-Origin = "*"` for every function. The survey function sets its own per-origin CORS headers, and the static header would override them with a wildcard, which is fine for a write-only endpoint but sloppy. Tighten by scoping that header block to the dashboard functions or removing it and letting each function answer its own CORS.
3. `DASHBOARD_PASSWORD` is already set for the dashboard; the GET reader reuses it (Bearer token = HMAC as in `auth.mjs`).

## Deploy

`npm run deploy` from `dashboard/` (Netlify CLI, production). Nothing is deployed until Ezra says so.

## Smoke test after deploy

- `curl -X OPTIONS -H "Origin: https://behappybeyou.net" -i https://<site>/.netlify/functions/cro-survey` returns 204 with the origin echoed.
- `curl -X POST -H "Origin: https://behappybeyou.net" -H "Content-Type: text/plain" --data '{"score":4,"reason_code":"price","page_path":"/test"}' https://<site>/.netlify/functions/cro-survey` returns 202.
- Same POST without an allowed Origin returns 403. `score: 9` returns 400.
- `curl -H "Authorization: Bearer <token>" "https://<site>/.netlify/functions/cro-survey?since=2026-09-01"` lists the rows.

## Privacy

No email, no IP, no user agent stored. Rows carry the first-party `bhby_sid`, the Clarity session id (for opening a recording) and cart token. The widget only POSTs when `Shopify.customerPrivacy.analyticsProcessingAllowed()` is true.
