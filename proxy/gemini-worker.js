/**
 * Element 26 — plan-reader proxy
 *
 * Element 26 is one static HTML file, which means anything inside it is public the
 * moment it is served. A Gemini key in that file is readable by every visitor and by
 * every scanner that crawls public sites, and no amount of encoding changes that: the
 * browser has to reconstruct the real key to send it, so obfuscation hides it from the
 * scanner and not from the person you are actually worried about.
 *
 * This Worker is the way out. It holds the key as a Cloudflare secret, and the app
 * calls THIS instead of Google. Requests leaving the browser carry no credential at
 * all, so there is nothing in the page to find, report, or rotate.
 *
 * What it does, and deliberately nothing else:
 *   • answers the CORS preflight
 *   • refuses anything that is not a POST from an origin you listed
 *   • caps how many requests one address may make, because the origin check alone is
 *     not a wall — see below
 *   • caps the body so it cannot be used to relay something enormous
 *   • pins the model to a list, so it cannot be turned into a general-purpose Gemini
 *   • attaches the key and forwards to Google, returning the response verbatim
 *
 * Returning Google's response untouched matters: the app already knows how to read
 * Google's error shapes, so proxied and direct modes fail identically and there is one
 * set of error messages to maintain rather than two.
 *
 * Deploy: see README.md in this folder.
 */

/* Who may call this. An empty list would make the Worker a free Gemini endpoint for
   anyone who found the URL, so it is not allowed to be empty — see the guard in
   fetch(). Use the exact scheme+host you serve the app from.

   WHAT THE ORIGIN CHECK IS ACTUALLY WORTH. Against a browser it is a wall: a copy of
   this app hosted anywhere else sends its own Origin, the request is refused, and the
   copy cannot use this key. Against a script it is a speed bump, because Origin is just
   a header and curl will send whatever you tell it to. That is not a flaw to be fixed —
   there is no header a browser sends that a script cannot forge — it is the reason the
   rate limit below exists. The origin check stops clones; the rate limit stops whoever
   read the URL out of the page and started a loop. */
const ALLOWED_ORIGINS = [
  "https://brother12334.github.io",
];

/* Models this proxy will forward when the APP asks for one by name. The allowlist stops
   a stranger pointing your key at something more expensive; it is not a claim that any
   of these still exist, which is what resolveModel() below is for. */
/* Refreshed after gemini-2.5-flash, gemini-2.0-flash and gemini-3-flash all turned out
   to be retired for this key ("no longer available to new users"/"no longer available"),
   confirmed by calling each directly. gemini-3.6-flash and gemini-3.5-flash-lite are
   confirmed live. gemini-flash-latest stays in the list even though it is no longer the
   app's own default — it is still a valid thing for resolveModel() below to land on. */
const ALLOWED_MODELS = [
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  /* Deliberately kept available to pin. It is not the newest and that is the point: an
     older model carries the larger free-tier allowance, and reading a document into JSON
     does not need the newest anything. When the quota is the binding constraint rather
     than the capability, this is the one to be on. */
  "gemini-2.5-flash",
];

/* WHY THIS PROXY PICKS ITS OWN MODEL WHEN THE NAMED ONE IS GONE.
   Google retires model names on its own schedule, and does it per-key: a name that
   works for an account set up last year answers "no longer available to new users" for
   one set up last week. A hard-coded name is therefore a scheduled outage — the app
   keeps working right up until the day it doesn't, and the person who has to fix it is
   whoever published the file, not the person standing in the gym trying to import a
   plan. So a 404 is treated as "that name is gone", not as a fatal error: the Worker
   asks Google what this key can actually use, picks the closest thing, and retries once.

   Preference order, highest score first. Flash-class only, because all this does is
   read a document into JSON — reasoning models cost more and are no better at it. */
function scoreModel(name) {
  let s = 0;
  if (/flash/.test(name)) s += 100;          // fast and cheap, which is the whole job
  if (/-latest$/.test(name)) s += 50;        // an alias survives the next retirement
  if (/lite/.test(name)) s -= 15;            // capable enough beats cheapest
  if (/preview|-exp|experimental/.test(name)) s -= 40;   // never pin to a preview
  const v = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  s += v * 5;                                // newer generation wins ties
  return s;
}

/* Cached per isolate so the extra lookup happens roughly once, not once per import.
   The TTL is short enough that fixing things on Google's side takes effect the same
   hour rather than needing a redeploy. */
let RESOLVED = null;
const RESOLVE_TTL_MS = 60 * 60 * 1000;

const MAX_BODY_BYTES = 14 * 1024 * 1024;   // Gemini's own inline-data ceiling is ~15 MB

/* PER-ADDRESS CAP. Reading a plan is a rare thing to do — a handful of calls on the day
   somebody imports, and then nothing for weeks — so a ceiling generous enough to be
   invisible to a real person is still low enough that a loop hits it in seconds.

   Cloudflare's own rate-limit binding rather than KV, deliberately: KV is eventually
   consistent, which makes it a damper rather than a limit, and it would mean giving the
   plan reader a storage binding it otherwise has no business holding. Configured in
   wrangler.toml; if the binding is absent the check is skipped rather than failing
   closed, because an unconfigured limiter must not be able to take the importer down. */
const RATE_KEY_HEADER = "CF-Connecting-IP";
async function overLimit(request, env) {
  const limiter = env && env.PLAN_LIMIT;
  if (!limiter || typeof limiter.limit !== "function") return false;
  const key = request.headers.get(RATE_KEY_HEADER) || "unknown";
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (e) {
    return false;
  }
}
const API = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE = API + "/models/";

/* Every model this key may actually call, which is the only authority on the question.
   Filtered to the ones that support generateContent, because the list also carries
   embedding and other models that would 404 in a different way. */
async function availableModels(key) {
  let r;
  try {
    r = await fetch(API + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function resolveModel(key, avoid) {
  if (RESOLVED && Date.now() - RESOLVED.at < RESOLVE_TTL_MS && RESOLVED.name !== avoid) {
    return RESOLVED.name;
  }
  const list = (await availableModels(key)).filter((m) => m !== avoid);
  if (!list.length) return null;
  const best = list.sort((a, b) => scoreModel(b) - scoreModel(a))[0];
  RESOLVED = { name: best, at: Date.now() };
  return best;
}

/* ONE ALTERNATIVE WAS NOT ENOUGH, AND THE REASON IS QUOTA RATHER THAN AVAILABILITY.

   This branch was written for a retired model name, where one substitution is plainly
   sufficient: the name is gone, something else is there, use it. Quota does not behave
   like that. Free-tier allowances are granted per model and the newest models get the
   smallest ones — a brand-new flash release has shipped with a 20-request DAILY cap —
   so "the highest-scoring model that is not the one that just failed" walks straight
   from one exhausted new model onto another. Observed exactly that: asked for
   gemini-3.6-flash, served by gemini-flash-latest, refused again with "You exceeded your
   current quota", while gemini-2.5-flash sat further down the list with the generous
   free allowance an older model keeps.

   So it walks the list instead of taking one step down it. Bounded, and it stops the
   moment something answers — or the moment an answer comes back that a different model
   would not fix. Every candidate is remembered so the chain cannot revisit one. */
/* AND A QUOTA FAILURE WANTS THE OPPOSITE ORDERING FROM A RETIREMENT.

   scoreModel() ranks newest-first, which is right when a name has been retired: the model
   is gone, take the best thing that is there. It is precisely wrong when the refusal is a
   quota, because free-tier allowances run the other way — Google grants established
   models a generous daily request count and ships brand-new releases with tiny ones (the
   20-a-day cap noted above was on a model released that month). Ranking newest-first
   under a 429 walks from one squeezed new model to the next and never reaches the older
   one that still has room. Measured on a real key: 3.6-flash, flash-latest,
   flash-lite-latest, 3.8-flash, all refused, while 2.5-flash sat untouched below them.

   So under a 429 the generation term is inverted and the "-latest" aliases are penalised
   rather than rewarded — an alias tracks the newest model, which is the squeezed one.
   This is a heuristic about how allowances are handed out, not a rule Google publishes,
   and it costs nothing when wrong: the walk is bounded and stops at the first answer. */
function scoreForQuota(name) {
  let s = 0;
  if (/flash/.test(name)) s += 100;
  if (/preview|-exp|experimental/.test(name)) s -= 40;
  if (/lite/.test(name)) s -= 5;          // lite usually has the LARGER free allowance
  if (/-latest$/.test(name)) s -= 30;     // an alias points at the newest, so at the smallest
  const v = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  if (v) s += (10 - Math.min(10, v)) * 5; // older generation wins, which is the whole point
  return s;
}
const FALLBACK_TRIES = 3;
async function fallbackModels(key, tried, status) {
  const score = status === 429 ? scoreForQuota : scoreModel;
  const list = (await availableModels(key)).filter((m) => !tried.includes(m));
  return list.sort((a, b) => score(b) - score(a)).slice(0, FALLBACK_TRIES);
}

async function callGoogle(model, body, key) {
  return fetch(GOOGLE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
}

/* The app reads `error.message` out of whatever comes back, so failures raised HERE use
   Google's error shape too. Otherwise a proxy rejection would surface as a blank. */
const fail = (status, message, origin) =>
  json({ error: { code: status, message } }, status, origin);

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin || "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  /* WITHOUT THIS THE APP CANNOT READ X-E26-Model AT ALL. A cross-origin response only
     exposes the handful of safelisted headers to script unless it says otherwise, so the
     header that records which model actually answered was visible in the network tab and
     invisible to the code — which is no use at all when the import failed on a phone and
     the question is whether the fallback ran. */
  "Access-Control-Expose-Headers": "X-E26-Model",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(allowed ? origin : "") });
    }
    if (request.method !== "POST") {
      return fail(405, "This endpoint only accepts POST.", "");
    }
    if (!ALLOWED_ORIGINS.length) {
      /* Left unconfigured this would relay for anyone, so it refuses instead. 403 maps
         to the app's "problem at our end, not yours" message, which is exactly right:
         it is the publisher's to fix. */
      return fail(403, "Proxy has no allowed origins configured.", "");
    }
    if (!allowed) {
      return fail(403, "Origin not allowed.", "");
    }
    /* After the origin check so a refused clone never consumes anybody's allowance, and
       before the key is touched so a flood costs nothing upstream. 429 is a status the
       app already has a sentence for. */
    if (await overLimit(request, env)) {
      return fail(429, "Too many plan reads from this connection. Give it a minute.", origin);
    }
    if (!env.GEMINI_API_KEY) {
      return fail(500, "Proxy is missing its GEMINI_API_KEY secret.", origin);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return fail(413, "That request was too large to forward.", origin);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "Body was not valid JSON.", origin);
    }

    /* A diagnostic, not a feature: {"list":true} answers with every model this key can
       actually call. It is behind the same origin check as everything else, so it is
       reachable from your own site's console and nowhere else, and it exists because
       "which models do I have?" is otherwise unanswerable without putting the key
       somewhere it should not go. */
    if (body && body.list === true) {
      const models = await availableModels(env.GEMINI_API_KEY);
      return json({ models, resolved: RESOLVED && RESOLVED.name }, 200, origin);
    }

    /* `model` is the app's only say in where this goes, and it is checked rather than
       trusted. Everything else is passed through untouched. */
    const model = String(body.model || "");
    if (!ALLOWED_MODELS.includes(model)) {
      return fail(400, `Model "${model}" is not allowed by this proxy.`, origin);
    }
    delete body.model;

    let upstream;
    try {
      upstream = await callGoogle(model, body, env.GEMINI_API_KEY);
    } catch {
      return fail(502, "Couldn't reach Google from the proxy.", origin);
    }

    /* The model was retired (404), hit its own quota (429), or is overloaded right now
       (503, and 500 often enough to be worth the same treatment). All of them are the
       same underlying situation from here — this one NAME is not usable at this moment
       for a reason that has nothing to do with the request — so all of them ask what
       else this key can call and retry once.

       429 was added to this list after "gemini-flash-latest" landed on a brand-new
       model with a 20-request daily free cap, RESOURCE_EXHAUSTED, quotaId
       GenerateRequestsPerDayPerProjectPerModel-FreeTier — a genuinely per-MODEL quota,
       confirmed by the same key succeeding immediately against a different model. The
       existing `avoid` parameter to resolveModel() is what keeps the retry from landing
       right back on the model that just failed: it filters that name out of the
       candidates before scoring, so a fresh lookup cannot simply re-choose it. */
    /* 503 IS THE COMMON ONE AND IT WAS THE ONE NOT HANDLED. "The model is overloaded,
       please try again later" is Google's busiest-hour answer, it is per-MODEL, and it
       is the exact failure a different model fixes instantly — the same key answers 200
       against a sibling flash model in the same second. It was passed straight through
       to the app, which could only show "our servers are having a moment" and give up.
       500 INTERNAL joins it for the same reason: retrying the identical request against
       the identical name is the one thing guaranteed not to help.

       A 400 stays excluded. That is a malformed request, and no amount of switching
       models fixes a body Google cannot parse. */
    const SWITCH_MODEL_ON = [404, 429, 500, 503];
    let served = model;
    if (SWITCH_MODEL_ON.includes(upstream.status)) {
      const tried = [model];
      for (const alt of await fallbackModels(env.GEMINI_API_KEY, tried, upstream.status)) {
        tried.push(alt);
        let retry;
        try {
          retry = await callGoogle(alt, body, env.GEMINI_API_KEY);
        } catch {
          continue;   /* this one is unreachable; the next may not be */
        }
        upstream = retry;
        served = alt;
        if (retry.ok) {
          RESOLVED = { name: alt, at: Date.now() };
          break;
        }
        /* A status no model change can help — a malformed body, say — ends the walk
           rather than spending three requests learning the same thing three times. */
        if (!SWITCH_MODEL_ON.includes(retry.status)) break;
      }
    }

    /* Verbatim, status included. A 429 from Google has to arrive at the app as a 429 or
       the rate-limit message it already has never fires. The extra header names which
       model actually answered, so a substitution is visible in the network tab instead
       of being silent. */
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "X-E26-Model": served,
        ...cors(origin),
      },
    });
  },
};
