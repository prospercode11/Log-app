 Plan-reader proxy

Element 26 is one static HTML file. Anything inside it is public the moment it is
served — including a Gemini API key, which is why Google emails you about it.

This Worker fixes that properly: it holds the key, the app calls the Worker, and
requests leaving the browser carry no credential at all.

**Free tier is enough.** Cloudflare Workers gives 100,000 requests/day at no cost and
asks for no card. A plan import is two requests: a small screening call that decides
whether the document is a usable training plan at all, then the extraction itself. A
document the screening call rejects never reaches the extraction, so an unreadable scan
or a nutrition sheet costs one cheap request rather than a full read.

---

## Before anything else: kill the leaked key

If a key has ever been in a published file, it is spent. Restricting it is not enough,
and deleting it from the file is not enough — published pages get crawled, and
committed files stay in git history.

1. https://aistudio.google.com/apikey
2. Delete the exposed key.
3. Create a new one. It goes into the Worker below and **nowhere else**.

---

## Deploy, about five minutes

```bash
npm install -g wrangler          # once
wrangler login                   # opens a browser
```

Then, from this folder:

```bash
wrangler deploy gemini-worker.js --name element26-gemini --compatibility-date 2024-11-01
```

Wrangler prints a URL like `https://element26-gemini.<your-subdomain>.workers.dev`.

Give it the key — this stores it encrypted on Cloudflare, never in your repo:

```bash
wrangler secret put GEMINI_API_KEY --name element26-gemini
# paste the new key when prompted
```

---

## Wire it up

**1. Allow your site.** In `gemini-worker.js`, add the exact origin you serve the app
from to `ALLOWED_ORIGINS`:

```js
const ALLOWED_ORIGINS = [
  "https://brother12334.github.io",
];
```

Scheme and host only — no path, no trailing slash. Without this the Worker refuses
everything, on purpose: an open proxy is a free Gemini endpoint for whoever finds the
URL. Re-run `wrangler deploy` after editing.

**2. Point the app at it.** At the top of `index.html`:

```js
const AI_PROXY = "https://element26-gemini.<your-subdomain>.workers.dev";
const AI_KEY   = "";      // stays empty. Forever.
```

Publish. The key is now server-side and there is nothing in the page to find.

---

## Check it works

Open the app, **Program → ✨ Import a plan**, paste a couple of lines of a workout,
press Read. In DevTools → Network you should see one request to your `workers.dev`
URL, and searching the page source for `AIza` should find nothing.

From a terminal, a request with no `Origin` header should be refused:

```bash
curl -i -X POST https://element26-gemini.<your-subdomain>.workers.dev \
  -H 'Content-Type: application/json' -d '{"model":"gemini-2.5-flash"}'
# expect: HTTP/2 403  {"error":{"code":403,"message":"Origin not allowed."}}
```

---

## When something breaks

The app shows a plain-English message; these are the causes behind them.

| What you see | What happened |
|---|---|
| "isn't switched on for this copy" | `AI_PROXY` is empty, or the Worker returned 401 |
| "problem at our end, not yours" | 403 — origin missing from `ALLOWED_ORIGINS`, or the key is invalid |
| "busy — it's had a lot of use today" | 429, the free-tier quota is shared across everyone using the app |
| "misconfigured (no model called…)" | `AI_MODEL` in index.html isn't in `ALLOWED_MODELS` here |

`wrangler tail --name element26-gemini` streams live logs if you need to see the
Worker's side.

---

## Other hosts

Nothing here is Cloudflare-specific beyond the export shape. The same 60 lines port to
Deno Deploy, Netlify Functions, or Vercel Edge — read the key from that platform's env
instead of `env.GEMINI_API_KEY`, and keep the origin check.

---

# The account service (optional)

`accountworker.js` is a second, separate Worker. Element 26 does not need it: an
account created with no service configured is real, it names your data and namespaces
your storage, and it lives on the device that made it. Deploy this one and the same
account becomes portable — sign in on a phone with the ID and recovery key from a
laptop, and the log follows.

**What it stores.** One record per account (`name`, a SHA-256 hash of the recovery key,
a created-at) and one blob per account (the app's own state). Nothing else. No email, no
password, no GitHub.

**How access works.** The User ID identifies an account. The recovery key authenticates
it. Every route that touches private data requires both, in one `Authorization` header,
and the account is derived from the credential rather than read from a path or a
parameter — so there is no id to change in a URL, and an ID on its own reads nothing.
Keys are compared in constant time against a stored hash; a dump of the database does
not hand anybody the credentials it protects. `POST /session` answers the same 401 for
"no such account" and "wrong key", so it cannot be used to test whether an ID exists.

## Deploy

```bash
wrangler kv namespace create E26_ACCOUNTS       # prints an id
```

The repo already has `wrangler.accounts.toml` at its root with a placeholder for that id
— open it, replace `REPLACE_WITH_KV_NAMESPACE_ID` with what wrangler printed, then:

```bash
wrangler deploy proxy/accountworker.js --name element26-accounts --config wrangler.accounts.toml
```

Add the origin you serve the app from to `ALLOWED_ORIGINS` at the top of
`accountworker.js`, then set `E26_API` near the top of `index.html` to the Worker's
URL. **No secret goes in the page** — the whole design is that the page holds an
identifier and the device holds a key, and the service is the only thing that can match
them.

## Check it works

```bash
# create an account
curl -s -X POST https://element26-accounts.<sub>.workers.dev/account \
  -H 'Origin: https://your.site' -H 'Content-Type: application/json' \
  -d '{"name":"Test"}'
# → {"id":"E26-7F42-K9P3","key":"…32 hex…","name":"Test"}

# the ID alone gets you nothing
curl -i https://element26-accounts.<sub>.workers.dev/data \
  -H 'Origin: https://your.site' -H 'Authorization: Bearer E26-7F42-K9P3.'
# → HTTP/2 401
```

## Deleting an account

`DELETE /account`, with the same `Authorization` header as everything else — the ID
alone cannot do it. It removes the account record and its data blob, with no soft-delete
and nothing to restore from. The app asks twice and makes you type your ID before it
calls this.

## If both halves are lost

The account is gone, and that is the honest trade for having no email and no password.
The app says so at sign-up and shows the ID once, big, behind a confirmation — and the
recovery key is always visible again under **Settings → Account**.

## Reminders (optional)

One notification a day, at an hour the person picks, naming the session that is up. Off
until you do all three of these; leave any of them undone and the app hides the whole
card rather than offering a switch that does nothing.

**1. Generate a VAPID keypair.** This is the identity the push services check when
something claims to be sending on your behalf.

```bash
npx web-push generate-vapid-keys
# Public Key:  BEl62iU…   (87 chars, base64url)
# Private Key: 3KzvKas…   (43 chars, base64url)
```

**2. The private half goes to the Worker, never into the page.**

```bash
wrangler secret put VAPID_PRIVATE_KEY --config wrangler.accounts.toml
wrangler secret put VAPID_PUBLIC_KEY  --config wrangler.accounts.toml
wrangler secret put VAPID_SUBJECT     --config wrangler.accounts.toml   # mailto:you@example.com
wrangler deploy proxy/accountworker.js --name element26-accounts --config wrangler.accounts.toml
```

`VAPID_SUBJECT` is a contact address the push services use if something goes wrong at
their end; it is not shown to anyone using the app. It defaults to a placeholder, which
works, but a real address is the polite thing.

**3. The public half goes in `index.html`,** as `VAPID_PUBLIC`, near `E26_API`. It is a
public key and belongs in a public file — that is the whole point of the pair.

`wrangler.accounts.toml` already carries the `[triggers]` block that runs the sender.

### On iPhone, it must be added to the Home Screen

Safari implements Web Push only for an installed web app, on iOS 16.4 or later. In a
Safari tab there is no subscription to be had, at all — not a degraded one. Share →
**Add to Home Screen**, then open it from there and turn reminders on inside that copy.
The app detects this and says so rather than presenting a switch that fails silently.

### What actually gets sent

Three kinds, each switchable on its own, and nothing else:

| kind | when | what it says |
|---|---|---|
| `train` | an hour you pick | which session is up, or that today is a rest day. Skipped on a day you have already trained. |
| `bed` | your night-start time, the one the app already uses | a nudge to start the sleep clock. Not sent on a night you have already answered. |
| `wake` | roughly when you get up | a prompt to log the night while you can still remember it. |

The morning one is aimed by measurement, not assumption. The wake sheet already asks
"just woken up?"; recording the clock time of that answer turns every logged night into a
sample, and the reminder lands on the median of them — median so that one early flight or
one lie-in moves it by nothing. Under three samples there is no prediction and no morning
reminder, and the app says that rather than inventing a seven o'clock and being wrong at
somebody every day for a week. A wake time set by hand under **Sleep** overrides all of
it. If the sleep clock is running and a typical night from when the phone actually went
down lands after the usual hour, the reminder moves later — never earlier.

The push itself carries no payload. It wakes the service worker, which fetches the one
sentence waiting for it and shows that. An encrypted payload would mean this service
holding key material for a device, and the text would sit in KV either way — so it stays
out, and the token the service worker carries reads one message and cannot touch a
training log.

The app decides *what* each sentence says and *when* it is due, and posts all of them
together; a kind it leaves out is deleted. All of the rotation and sleep logic stays in
the app, where it already lives. Two kinds coming due in the same minute are collected and
queued in one write, so neither can overwrite the other.

