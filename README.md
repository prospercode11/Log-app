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

- **App:** static files, deployed on Vercel from this repo (every push redeploys). Any
  static host works; if you use a new domain, add it to
  `supabase/functions/_shared/origins.ts` and redeploy the functions.
- **Backend:** Supabase: accounts and cloud sync, push reminders, and the AI plan reader.
  See [`supabase/README.md`](supabase/README.md). The plan reader needs a Gemini API key
  set server-side; everything else works out of the box.

## Copy tooling

`tools/copy/` pulls every on-screen string out of `index.html` for editing. See
[`tools/copy/README.md`](tools/copy/README.md).
