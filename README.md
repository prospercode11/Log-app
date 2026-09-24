# Element 26

A training log that reads what you lift and tells you what to change. The app is a single
static page (`index.html`) plus a service worker (`sw.js`) and a PWA manifest, so there is
no build step.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

- **App:** serve the repo root as static files (e.g. GitHub Pages → Settings → Pages →
  Deploy from branch → `main` / root).
- **Plan-reader proxy and account service:** two Cloudflare Workers in `proxy/`, set up with
  `wrangler.toml` and `wrangler.accounts.toml`. Full steps are in [`proxy/README.md`](proxy/README.md).
  Add the origin you serve the app from to `ALLOWED_ORIGINS` in both
  `proxy/gemini-worker.js` and `proxy/accountworker.js`, and point `AI_PROXY` / `E26_API`
  in `index.html` at your Worker URLs.

## Copy tooling

`tools/copy/` pulls every on-screen string out of `index.html` for editing. See
[`tools/copy/README.md`](tools/copy/README.md).
