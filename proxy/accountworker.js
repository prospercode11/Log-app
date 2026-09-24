/**
 * Element 26 — account service
 *
 * Optional. Element 26 works without it: an account created with no service configured
 * is real, it names and namespaces your data, and it lives on the device that made it.
 * Deploy this and the same account becomes portable — sign in on a phone with the ID and
 * recovery key from a laptop and the log follows.
 *
 * WHAT AN ACCOUNT IS HERE
 *
 *   id   E26-XXXX-XXXX. Public-ish: shown to the user, written on paper, quoted in a
 *        support email. It NAMES an account.
 *   key  32 hex characters, generated once, never shown again except in the user's own
 *        Settings screen. It AUTHENTICATES the account.
 *
 * The distinction is the entire security model, so it is enforced in one place and only
 * one place: auth() below. Every route that touches private data goes through it, it
 * requires both halves, and it compares the key in constant time against the stored
 * hash. An id on its own — the thing most likely to leak — reads nothing and writes
 * nothing. There is no route that takes an id alone and answers with data, and no route
 * that lets a caller name whose data it wants: the account is derived from the
 * credential, never from a parameter, which is what makes "change the id in the URL"
 * impossible rather than merely discouraged.
 *
 * The key is stored as a SHA-256 hash. A dump of the KV namespace therefore does not
 * hand anybody the credentials it protects.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   • no email, no password, no reset flow — there is nothing to phish, and nothing to
 *     take over. Lose both halves and the account is gone; the app says so plainly at
 *     sign-up rather than implying a recovery that does not exist.
 *   • no listing, no search, no admin route. There is no way to enumerate accounts.
 *   • no GitHub. The gist/repo backup in the app is separate, optional and invisible to
 *     anyone who has not deliberately set it up.
 *
 * DEPLOY
 *
 *   wrangler kv namespace create E26_ACCOUNTS
 *   # put the returned id in wrangler.accounts.toml (see proxy/README.md)
 *   wrangler deploy proxy/accountworker.js --name element26-accounts --config wrangler.accounts.toml
 *
 * Then set E26_API in index.html to the Worker's URL. No secret goes in the page.
 */

const ALLOWED_ORIGINS = [
  "https://brother12334.github.io",
];

const MAX_BODY = 4 * 1024 * 1024;      // a very long training history is ~1 MB of JSON
/* Account creation is the one route that makes something out of nothing, so it is the
   one worth abusing: a loop against it fills the namespace and burns the free tier.
   Capped per client address per hour. Deliberately coarse — KV is eventually consistent
   and this is a damper, not a quota — and deliberately not applied to the authenticated
   routes, where the credential is already the limit. */
const NEW_ACCOUNTS_PER_HOUR = 20;
const ID_RE = /^E26-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const KEY_RE = /^[a-f0-9]{32,64}$/;
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0] || "null",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
  });
}
function randomFrom(alphabet, n) {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
function newId() {
  return "E26-" + randomFrom(ID_ALPHABET, 4) + "-" + randomFrom(ID_ALPHABET, 4);
}
function newKey() {
  return randomFrom("abcdef0123456789", 32);
}
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* Length-independent, branch-free comparison. Overkill for a KV lookup on the edge, and
   still the right habit: a comparison that returns early on the first wrong character
   leaks how much of a guess was right. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* =====================================================================
   PUSH NOTIFICATIONS

   Optional on top of optional: leave the two VAPID secrets unset and every route below
   answers "not configured" and the app hides the whole feature. Nothing else changes.

   WHAT IS STORED, AND WHY IT IS SO LITTLE
     push:<id>    that account's one installed app: the push service endpoint, the two
                  RFC 8291 keys any sender needs to encrypt a message for it, a device
                  label, and a random token for the payload-less path below.
     ptok:<token> reverse lookup for that token. It authorises exactly one thing.
     sched:<id>:<kind>
                  the next reminder OF THAT KIND: {at, title, body}. One per kind, never
                  more, and posting replaces it — so there is no queue to drift out of
                  step with the plan it came from. The app posts the whole set at once and
                  a kind it leaves out is deleted, which is how turning one off works.
     pend:<id>    a short list of what the service worker is about to come and ask for,
                  for the seconds between a push landing and the worker reading it. A list
                  rather than a single value because two kinds can come due in the same
                  minute, and the second must not overwrite the first. Self-expiring.

   THIS SERVICE'S OWN PUSHES CARRY NO BODY, and that has not changed: a reminder is
   signed, POSTed empty, and the text is fetched by the service worker a moment later
   against a token that reads one message and cannot touch the training log. Implementing
   aes128gcm here to say "Upper A" would be work in exchange for nothing.

   THE SUBSCRIPTION KEYS ARE STORED ANYWAY. They belong to the subscription rather than
   to this service's design, they exist only on the object the browser hands back at
   subscribe time and cannot be recovered afterwards, and without them the ONLY thing
   this record can ever deliver is a wake-up with no words in it — which forecloses every
   other sender, the admin console included. What they are worth to an attacker is
   bounded and worth stating: with the VAPID private key as well, they allow sending a
   notification to that device. They read nothing.

   THE APP DECIDES WHAT IT SAYS. Which day is up, whether a rest is owed, whether you
   already trained — all of that is rotation logic that already exists in the app and
   would rot immediately if it were reimplemented here against a copy of the data. So the
   app computes one sentence and one timestamp and posts them; this stays dumb on
   purpose, and a change to how the plan works needs no deploy here. */
/* BUG REPORTS. Written by the app, read by the admin console straight out of KV — the
   same arrangement push: has, and for the same reason: the console holds the namespace
   binding, so there is no route here that hands anybody else's report to a caller.

   Authenticated, because an anonymous report endpoint is a spam target with a database
   attached, and because a report worth reading is one you can reply to. Capped per
   account per hour for the same reason account creation is.

   `report:` sorts by time because the timestamp is zero-padded into the key, so the
   console lists newest-first off the key names alone without reading a single record. */
const REPORT_MAX_TEXT = 2000;
const REPORT_MAX_ERRORS = 5;
const REPORTS_PER_HOUR = 6;
const REPORT_KINDS = ["bug", "idea", "other"];

const VAPID_TTL = "86400";
/* The kinds of reminder that exist. Named here only so a client cannot invent an
   unbounded set of them and fill the namespace one key at a time; what each one MEANS is
   entirely the app's business and this service never looks. */
const SCHED_KINDS = ["train", "bed", "wake"];
const PEND_MAX = 4;
const SCHED_MAX_AHEAD = 60 * 24 * 3600 * 1000;   // sanity bound, not a policy
const TOKEN_RE = /^[a-f0-9]{32}$/;
/* Every device label the app can send; see deviceLabel() in index.html. */
const UA_LABELS = ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux", "Device"]
  .flatMap((d) => [d, d + " (installed)"]);
/* Push services are a small, known set. An endpoint is a URL this service will make an
   authenticated POST to on a schedule, so it is not somewhere a caller gets to point
   anywhere it likes — that would make this an open relay wearing a Worker. */
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /(^|\.)googleapis\.com$/,
  /(^|\.)mozilla\.com$/,
  /(^|\.)windows\.com$/,
  /(^|\.)microsoft\.com$/,
];
function pushConfigured(env) {
  return !!(env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}
function b64uFromBytes(bytes) {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uToBytes(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64uFromString(str) {
  return b64uFromBytes(new TextEncoder().encode(str));
}
/* The private key arrives as the raw 32-byte scalar, base64url — which is exactly what
   `web-push generate-vapid-keys` prints. WebCrypto will not import that on its own, so
   the public half is split back into its x and y coordinates and the three are handed
   over as a JWK. */
async function vapidKey(env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad VAPID_PUBLIC_KEY");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      d: String(env.VAPID_PRIVATE_KEY).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
      x: b64uFromBytes(pub.slice(1, 33)),
      y: b64uFromBytes(pub.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64uFromString(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64uFromString(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:push@element26.invalid",
  }));
  const input = head + "." + body;
  /* WebCrypto signs ECDSA as raw r||s, which is what the Web Push spec wants. A DER
     signature here would verify nowhere. */
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, await vapidKey(env), new TextEncoder().encode(input)
  );
  return "vapid t=" + input + "." + b64uFromBytes(sig) + ", k=" + env.VAPID_PUBLIC_KEY;
}
function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (u.protocol !== "https:") return false;
  return PUSH_HOSTS.some(re => re.test(u.hostname));
}
/* Returns true if the subscription is gone and should be forgotten. 404 and 410 are the
   push services' way of saying the app was deleted or the permission revoked; anything
   else is a bad afternoon and the subscription is kept. */
/* WHAT THE PUSH SERVICE SAID, KEPT. The status was computed, compared against two
   numbers and thrown away, so a service rejecting every send — a malformed JWT, a key
   the service will not accept, a quota — looked exactly like a service delivering every
   send: silence at both ends. "Notifications don't work on Android" is unanswerable
   without this, because Apple and FCM fail differently and neither says so out loud.

   One key, overwritten each send, expiring in a week. It holds a status code and a
   timestamp: nothing about the person, nothing about the notification. */
async function notePushResult(env, id, status, note) {
  try {
    await env.E26_ACCOUNTS.put("psend:" + id,
      JSON.stringify({ at: Date.now(), status: status, note: note || "" }),
      { expirationTtl: 604800 });
  } catch (e) {}
}
async function sendPush(env, endpoint) {
  /* Content-Length is a forbidden header name: fetch() is required to ignore whatever is
     set here, so it was never reaching the push service and was only ever documentation
     of an intent. A bodyless POST already sends no body. */
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(env, endpoint),
      "TTL": VAPID_TTL,
      "Urgency": "normal",
    },
  });
  return { gone: res.status === 404 || res.status === 410, status: res.status };
}
async function forgetPush(env, id) {
  const raw = await env.E26_ACCOUNTS.get("push:" + id);
  if (raw) {
    try { const p = JSON.parse(raw); if (p.token) await env.E26_ACCOUNTS.delete("ptok:" + p.token); } catch (e) {}
  }
  await env.E26_ACCOUNTS.delete("push:" + id);
  for (const k of SCHED_KINDS) await env.E26_ACCOUNTS.delete("sched:" + id + ":" + k);
  await env.E26_ACCOUNTS.delete("pend:" + id);
}
/* ONE ACCOUNT'S DUE REMINDERS, ALL OF THEM, IN ONE PASS — and it has to be one pass.

   Two kinds can come due in the same minute: a bedtime nudge at 22:30 and a training
   reminder somebody set to 22:30. Handling them independently means each reads the
   pending queue, appends itself and writes it back, and the two writes race — the second
   one lands on a queue it read before the first existed, and a notification is silently
   lost. KV has no atomic append to fix that with, so the fix is not to need one: every
   message for an account is collected first and the queue is written exactly once.

   Written so that a double delivery is the worst case rather than a lost one. Each
   schedule is cleared before its send, and a short-lived marker covers KV's eventual
   consistency across two cron ticks a minute apart. */
async function fireDue(env, id, items) {
  const now = Date.now();
  const msgs = [];
  for (const it of items) {
    const key = "sched:" + id + ":" + it.kind;
    const guard = "fired:" + id + ":" + it.kind + ":" + it.at;
    if (await env.E26_ACCOUNTS.get(guard)) continue;
    const raw = await env.E26_ACCOUNTS.get(key);
    if (!raw) continue;
    let sched;
    try { sched = JSON.parse(raw); } catch (e) { await env.E26_ACCOUNTS.delete(key); continue; }
    if (!(Number(sched.at) <= now)) continue;
    await env.E26_ACCOUNTS.put(guard, "1", { expirationTtl: 900 });
    await env.E26_ACCOUNTS.delete(key);
    msgs.push({ title: sched.title, body: sched.body, tag: sched.tag || ("e26-" + it.kind) });
  }
  if (!msgs.length) return;

  const rawP = await env.E26_ACCOUNTS.get("push:" + id);
  if (!rawP) return;
  let sub;
  try { sub = JSON.parse(rawP); } catch (e) { return; }
  if (!sub.endpoint) return;

  let queue = [];
  try { queue = JSON.parse(await env.E26_ACCOUNTS.get("pend:" + id) || "[]"); } catch (e) {}
  if (!Array.isArray(queue)) queue = [];
  await env.E26_ACCOUNTS.put("pend:" + id, JSON.stringify(queue.concat(msgs).slice(-PEND_MAX)),
    { expirationTtl: 3600 });

  /* One push per message, because one push event shows one notification. Sequential: a
     dead endpoint should stop the rest rather than being retried three times. */
  for (let i = 0; i < msgs.length; i++) {
    try {
      const r = await sendPush(env, sub.endpoint);
      await notePushResult(env, id, r.status, "");
      if (r.gone) { await forgetPush(env, id); return; }
    } catch (e) {
      /* A send that throws leaves the queue in place; it expires within the hour and the
         app will have posted a fresh schedule long before that matters. */
      await notePushResult(env, id, 0, String((e && e.message) || e).slice(0, 120));
      return;
    }
  }
}


/* THE ONLY WAY TO IDENTIFY A CALLER. Returns the account, or null. Note what it does
   not accept: an id in the path, an id in the body, an id in a query string. The caller
   presents a credential and the account falls out of it. */
async function auth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(E26-[0-9A-Z]{4}-[0-9A-Z]{4})\.([a-f0-9]{32,64})$/.exec(header.trim());
  if (!m) return null;
  const [, id, key] = m;
  const raw = await env.E26_ACCOUNTS.get("acct:" + id);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  const hash = await sha256(key);
  if (!sameSecret(hash, rec.keyHash || "")) return null;
  return { id, rec };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (!ALLOWED_ORIGINS.length) return json({ error: "not configured" }, 500, origin);
    /* A MISSING Origin USED TO PASS, and that was the hole. The check was written as
       "if you claim an origin, it must be one of mine", which is exactly backwards for a
       service whose only legitimate caller is a browser page: a browser always sends
       Origin on a cross-origin request, so the only callers with no Origin at all are
       scripts. POST /account needs no credential by definition, so that combination was
       an open account factory. Now the header is required, like the plan-reader proxy
       next door has always required it. Testing by hand means passing -H 'Origin: ...',
       which is what proxy/README.md already tells you to do. */
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden" }, 403, origin);
    if (!env || !env.E26_ACCOUNTS) return json({ error: "storage not bound" }, 500, origin);

    const url = new URL(request.url);
    /* Exact, not endsWith. "/x/account" matched the create route under the old test and
       would have kept matching anything somebody appended a known suffix to. */
    const path = url.pathname.replace(/\/+$/, "") || "/";

    /* CREATE. The only route that mints anything. The id and key are generated HERE,
       never accepted from the caller, so a client cannot claim an id it likes the look
       of or pick a weak key. The key is returned exactly once, in this response. */
    if (path === "/account" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const bucket = "rate:new:" + ip + ":" + Math.floor(Date.now() / 3600000);
      const seen = Number(await env.E26_ACCOUNTS.get(bucket)) || 0;
      if (seen >= NEW_ACCOUNTS_PER_HOUR) {
        return json({ error: "too many accounts created, try again later" }, 429, origin);
      }
      // expirationTtl so the counters clean themselves up rather than accumulating
      await env.E26_ACCOUNTS.put(bucket, String(seen + 1), { expirationTtl: 7200 });
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 32);
      let id = newId();
      // Vanishingly unlikely, cheap to rule out, catastrophic if it ever happened.
      for (let i = 0; i < 5 && await env.E26_ACCOUNTS.get("acct:" + id); i++) id = newId();
      const key = newKey();
      const rec = { name, keyHash: await sha256(key), createdAt: Date.now() };
      await env.E26_ACCOUNTS.put("acct:" + id, JSON.stringify(rec));
      return json({ id, key, name }, 201, origin);
    }

    /* VERIFY. Used when signing in on a second device. Answers 401 for a bad pair and
       says nothing about which half was wrong — "no such id" and "wrong key" are the
       same answer, so this cannot be used to test whether an id exists. */
    if (path === "/session" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const id = String(body.id || "").trim().toUpperCase();
      const key = String(body.key || "").trim().toLowerCase();
      if (!ID_RE.test(id) || !KEY_RE.test(key)) return json({ error: "unauthorized" }, 401, origin);
      const raw = await env.E26_ACCOUNTS.get("acct:" + id);
      if (!raw) return json({ error: "unauthorized" }, 401, origin);
      let rec;
      try { rec = JSON.parse(raw); } catch (e) { return json({ error: "unauthorized" }, 401, origin); }
      if (!sameSecret(await sha256(key), rec.keyHash || "")) return json({ error: "unauthorized" }, 401, origin);
      return json({ ok: true, name: rec.name || "" }, 200, origin);
    }

    /* DELETE. Requires the same credential as reading the data, for the same reason: an
       ID on its own must not be able to do anything at all, least of all this. Removes
       the account record and its blob; there is no soft-delete and nothing to restore
       from, which is what the app tells the person before it calls this. */
    if (path === "/account" && request.method === "DELETE") {
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      await env.E26_ACCOUNTS.delete("data:" + who.id);
      await env.E26_ACCOUNTS.delete("acct:" + who.id);
      return json({ ok: true }, 200, origin);
    }

    /* THE DATA. One blob per account, addressed by the credential and nothing else. */
    if (path === "/data") {
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);

      if (request.method === "GET") {
        const blob = await env.E26_ACCOUNTS.get("data:" + who.id);
        if (!blob) return json({ savedAt: 0, data: null }, 200, origin);
        return new Response(blob, {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
        });
      }
      if (request.method === "PUT") {
        const len = Number(request.headers.get("Content-Length") || 0);
        if (len > MAX_BODY) return json({ error: "too large" }, 413, origin);
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: "too large" }, 413, origin);
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { return json({ error: "bad json" }, 400, origin); }
        if (!parsed || typeof parsed !== "object" || !parsed.data) return json({ error: "bad body" }, 400, origin);
        await env.E26_ACCOUNTS.put("data:" + who.id, JSON.stringify({
          savedAt: Number(parsed.savedAt) || Date.now(),
          data: parsed.data,
        }));
        return json({ ok: true }, 200, origin);
      }
      return json({ error: "method not allowed" }, 405, origin);
    }

    /* PUSH: the service worker's one read. Authorised by the subscription token rather
       than the account credential, because a service worker is the wrong place to keep
       a recovery key. Reads one message and deletes it — there is nothing here to poll
       and nothing to accumulate. */
    if (path === "/push/pending" && request.method === "GET") {
      const t = String(url.searchParams.get("t") || "").toLowerCase();
      if (!TOKEN_RE.test(t)) return json({ error: "unauthorized" }, 401, origin);
      const id = await env.E26_ACCOUNTS.get("ptok:" + t);
      if (!id) return json({ error: "unauthorized" }, 401, origin);
      let queue = [];
      try { queue = JSON.parse(await env.E26_ACCOUNTS.get("pend:" + id) || "[]"); } catch (e) {}
      if (!Array.isArray(queue) || !queue.length) return json({}, 200, origin);
      const next = queue.shift();
      /* One push event, one notification, one message off the front. */
      if (queue.length) await env.E26_ACCOUNTS.put("pend:" + id, JSON.stringify(queue), { expirationTtl: 3600 });
      else await env.E26_ACCOUNTS.delete("pend:" + id);
      return json(next, 200, origin);
    }

    if (path === "/push/subscribe" && request.method === "POST") {
      if (!pushConfigured(env)) return json({ error: "push not configured" }, 501, origin);
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const endpoint = String(body.endpoint || "");
      if (!endpointAllowed(endpoint)) return json({ error: "bad endpoint" }, 400, origin);
      /* Bounded and shaped, because everything here is written by a client. p256dh is a
         65-byte point and auth is 16 bytes, both base64url; anything else is dropped
         rather than stored, and a record without them is still a working subscription
         for the payload-less path. */
      const b64u = (v, max) => {
        const t = String(v || "");
        return /^[A-Za-z0-9_-]+$/.test(t) && t.length <= max ? t : "";
      };
      const p256dh = b64u(body.keys && body.keys.p256dh, 120);
      const authKey = b64u(body.keys && body.keys.auth, 48);
      /* The label is a label, not free text. The app sends one of these and nothing
         else, so it is checked against the list rather than sanitised — sanitising asks
         "is this string safe to store", and the answer to "is it one of seven values" is
         both easier and correct. Anything else is stored as nothing. */
      const ua = UA_LABELS.indexOf(String(body.ua || "")) > -1 ? String(body.ua) : "";
      /* One installed app per account, by design: resubscribing replaces rather than
         adds, so an app deleted and reinstalled leaves nothing behind to send to. */
      await forgetPush(env, who.id);
      const token = randomFrom("abcdef0123456789", 32);
      /* `createdAt` rather than `at`: it is the name every other reader of this record
         uses, and one record written under two spellings is a bug waiting for whoever
         reads it next. */
      await env.E26_ACCOUNTS.put("push:" + who.id, JSON.stringify({
        endpoint,
        keys: { p256dh, auth: authKey },
        ua,
        token,
        createdAt: Date.now(),
      }));
      await env.E26_ACCOUNTS.put("ptok:" + token, who.id);
      return json({ ok: true, token }, 200, origin);
    }

    /* WHAT HAPPENED TO THE LAST ONE. Read-only, authenticated, and it answers the only
       question the device cannot answer for itself: did this service try, and what did
       the push service say. A 201 with nothing on the lock screen is the phone dropping
       it; a 403 is this service's problem and the app can say so. */
    if (path === "/push/status" && request.method === "GET") {
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      let last = null;
      try { last = JSON.parse(await env.E26_ACCOUNTS.get("psend:" + who.id) || "null"); } catch (e) {}
      const sub = await env.E26_ACCOUNTS.get("push:" + who.id);
      let host = "";
      try { host = sub ? new URL(JSON.parse(sub).endpoint).hostname : ""; } catch (e) {}
      return json({ ok: true, subscribed: !!sub, host, last }, 200, origin);
    }

    if (path === "/push/unsubscribe" && request.method === "POST") {
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      await forgetPush(env, who.id);
      return json({ ok: true }, 200, origin);
    }

    /* SCHEDULE. Exactly one reminder is stored per account and posting replaces it, so
       the app can recompute freely — after a session, after a plan change, at launch —
       without ever having to reason about what it queued last time. Posting no `at`
       cancels. */
    if (path === "/push/schedule" && request.method === "POST") {
      if (!pushConfigured(env)) return json({ error: "push not configured" }, 501, origin);
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      /* THE WHOLE SET, EVERY TIME. The app recomputes all of its reminders together from
         one consistent view of the plan, so it posts all of them together and a kind it
         leaves out is deleted. Anything else means reasoning here about which of two
         partial updates is the newer, which is exactly the drift this avoids. */
      const items = Array.isArray(body.items) ? body.items : [];
      const kept = [];
      for (const kind of SCHED_KINDS) {
        const it = items.find(x => x && x.kind === kind);
        const at = it ? Math.round(Number(it.at)) : NaN;
        if (!it || !isFinite(at) || at > Date.now() + SCHED_MAX_AHEAD) {
          await env.E26_ACCOUNTS.delete("sched:" + who.id + ":" + kind);
          continue;
        }
        await env.E26_ACCOUNTS.put(
          "sched:" + who.id + ":" + kind,
          JSON.stringify({
            at,
            /* The app always sends a title; this is only what a malformed post gets.
               Not the app's name — the device already says which app raised it. */
            title: String(it.title || "Reminder").slice(0, 80),
            body: String(it.body || "").slice(0, 200),
            tag: "e26-" + kind,
          }),
          { metadata: { at }, expirationTtl: Math.max(120, Math.ceil((at - Date.now()) / 1000) + 7 * 86400) }
        );
        kept.push({ kind, at });
      }
      return json({ ok: true, scheduled: kept }, 200, origin);
    }

    /* REPORT A PROBLEM. The diagnostics come from the client and are therefore capped
       and shaped rather than trusted — a report is a text box on the internet, and the
       one thing you can be sure of is that everything in it is somebody else's input. */
    if (path === "/report" && request.method === "POST") {
      const who = await auth(request, env);
      if (!who) return json({ error: "unauthorized" }, 401, origin);

      const bucket = "rate:rep:" + who.id + ":" + Math.floor(Date.now() / 3600000);
      const seen = Number(await env.E26_ACCOUNTS.get(bucket)) || 0;
      if (seen >= REPORTS_PER_HOUR) {
        return json({ error: "too many reports, try again later" }, 429, origin);
      }
      await env.E26_ACCOUNTS.put(bucket, String(seen + 1), { expirationTtl: 7200 });

      let body = {};
      try { body = await request.json(); } catch (e) {}
      const text = String(body.text || "").trim().slice(0, REPORT_MAX_TEXT);
      if (!text) return json({ error: "say what happened" }, 400, origin);

      const str = (v, n) => String(v == null ? "" : v).slice(0, n);
      const at = Date.now();
      /* Only the fields named here survive. A client that invents a field does not get
         it stored, which keeps a report a known shape for whatever reads it next. */
      const rec = {
        at,
        accountId: who.id,
        name: str((who.rec && who.rec.name) || "", 32),
        kind: REPORT_KINDS.indexOf(String(body.kind)) > -1 ? String(body.kind) : "bug",
        text,
        app: str(body.app, 16),
        sw: str(body.sw, 16),
        ua: str(body.ua, 300),
        installed: !!body.installed,
        tab: str(body.tab, 24),
        diag: {},
        errors: [],
        status: "new",
      };
      const diag = body.diag && typeof body.diag === "object" ? body.diag : {};
      Object.keys(diag).slice(0, 20).forEach((k) => {
        const key = k.slice(0, 24);
        const v = diag[k];
        rec.diag[key] = typeof v === "number" || typeof v === "boolean" ? v : str(v, 60);
      });
      if (Array.isArray(body.errors)) {
        rec.errors = body.errors.slice(0, REPORT_MAX_ERRORS).map((e) => ({
          msg: str(e && e.msg, 300),
          src: str(e && e.src, 200),
          line: Number(e && e.line) || 0,
          stack: str(e && e.stack, 1200),
          at: Number(e && e.at) || 0,
        }));
      }
      const key = "report:" + String(at).padStart(15, "0") + ":" + randomFrom("abcdef0123456789", 8);
      await env.E26_ACCOUNTS.put(key, JSON.stringify(rec), { metadata: { at, kind: rec.kind } });
      return json({ ok: true, id: key }, 201, origin);
    }

    return json({ error: "not found" }, 404, origin);
  },

  /* The cron. Configure it in wrangler.accounts.toml:
       [triggers]
       crons = ["* * * * *"]
     Minute granularity is the floor Cloudflare offers and it is the right unit here — a
     reminder to train is not a rest timer, and a minute either way is invisible.

     The scan is a KV list over one prefix, reading the due time out of each key's
     metadata rather than fetching every record, so an idle minute costs one list and no
     reads at all. */
  async scheduled(event, env, ctx) {
    if (!env || !env.E26_ACCOUNTS || !pushConfigured(env)) return;
    const now = Date.now();
    const due = new Map();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const res = await env.E26_ACCOUNTS.list({ prefix: "sched:", cursor, limit: 1000 });
      for (const k of res.keys) {
        const at = k.metadata && Number(k.metadata.at);
        if (!isFinite(at) || at > now) continue;
        const rest = k.name.slice(6);                 // "<id>:<kind>"
        const cut = rest.lastIndexOf(":");
        if (cut < 0) continue;
        const id = rest.slice(0, cut);
        /* Grouped by account, not left flat: everything due for one account has to be
           handled together — see fireDue(). */
        if (!due.has(id)) due.set(id, []);
        due.get(id).push({ kind: rest.slice(cut + 1), at });
      }
      if (res.list_complete) break;
      cursor = res.cursor;
    }
    /* Bounded concurrency ACROSS accounts, never within one: a hundred simultaneous
       fetches to a push service is how you get rate-limited by it, and two workers on the
       same account is the race fireDue() exists to avoid. */
    const accounts = [...due.entries()];
    for (let i = 0; i < accounts.length; i += 10) {
      await Promise.all(accounts.slice(i, i + 10)
        .map(([id, items]) => fireDue(env, id, items).catch(() => {})));
    }
  },
};
