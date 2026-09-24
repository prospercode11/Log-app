/**
 * Element 26 — plan-reader proxy (Supabase Edge Function)
 *
 * Holds the Gemini API key server-side so the page carries no credential. The app POSTs
 * a Gemini generateContent body plus a `model` name; this checks the origin, rate-limits
 * per address, pins the model to a list, attaches the key and forwards to Google,
 * returning Google's response verbatim (so the app's existing error handling applies).
 *
 * The key: set a function secret named GEMINI_API_KEY (Dashboard → Edge Functions →
 * Secrets), or insert it into public.e26_config as key 'gemini_api_key'.
 *
 * Deployed with verify_jwt = false: the browser sends no Supabase JWT; the origin check
 * and the per-address rate limit are the gate, exactly as on the old Worker.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientIp, originAllowed } from "../_shared/origins.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/* 40 reads a minute per address: invisible to a real import (two model calls, each with
   a few retries), and a loop hits it in seconds. */
const PLAN_READS_PER_MINUTE = 40;
const MAX_BODY_BYTES = 14 * 1024 * 1024;   // Gemini's own inline-data ceiling is ~15 MB

async function overLimit(req: Request): Promise<boolean> {
  try {
    const bucket = "plan:" + clientIp(req) + ":" + Math.floor(Date.now() / 60000);
    const { data, error } = await db.rpc("e26_bump", { p_bucket: bucket, p_ttl_seconds: 120 });
    if (error) return false;   // a broken limiter must not take the importer down
    return Number(data) > PLAN_READS_PER_MINUTE;
  } catch {
    return false;
  }
}

let KEY: string | null = null;
async function geminiKey(): Promise<string> {
  const env = Deno.env.get("GEMINI_API_KEY");
  if (env) return env;
  if (KEY) return KEY;
  const { data } = await db.from("e26_config").select("value").eq("key", "gemini_api_key").maybeSingle();
  KEY = (data && data.value) || "";
  return KEY || "";
}

/* Models this proxy will forward when the APP asks for one by name. The allowlist stops
   a stranger pointing your key at something more expensive; it is not a claim that any
   of these still exist, which is what the fallback walk below is for. */
/* Refreshed after gemini-2.5-flash, gemini-2.0-flash and gemini-3-flash all turned out
   to be retired for this key ("no longer available to new users"/"no longer available"),
   confirmed by calling each directly. gemini-3.6-flash and gemini-3.5-flash-lite are
   confirmed live. gemini-flash-latest stays in the list even though it is no longer the
   app's own default — it is still a valid thing for the fallback walk to land on. */
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
function scoreModel(name: string) {
  let s = 0;
  if (/flash/.test(name)) s += 100;          // fast and cheap, which is the whole job
  if (/-latest$/.test(name)) s += 50;        // an alias survives the next retirement
  if (/lite/.test(name)) s -= 15;            // capable enough beats cheapest
  if (/preview|-exp|experimental/.test(name)) s -= 40;   // never pin to a preview
  const v = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  s += v * 5;                                // newer generation wins ties
  return s;
}

/* Cached per isolate so the extra lookup happens roughly once, not once per import.
   The TTL is short enough that fixing things on Google's side takes effect the same
   hour rather than needing a redeploy. */
let RESOLVED: { name: string; at: number } | null = null;

const API = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE = API + "/models/";

/* Every model this key may actually call, which is the only authority on the question.
   Filtered to the ones that support generateContent, because the list also carries
   embedding and other models that would 404 in a different way. */
async function availableModels(key: string): Promise<string[]> {
  let r;
  try {
    r = await fetch(API + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
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
function scoreForQuota(name: string) {
  let s = 0;
  if (/flash/.test(name)) s += 100;
  if (/preview|-exp|experimental/.test(name)) s -= 40;
  if (/lite/.test(name)) s -= 5;          // lite usually has the LARGER free allowance
  if (/-latest$/.test(name)) s -= 30;     // an alias points at the newest, so at the smallest
  const v = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  if (v) s += (10 - Math.min(10, v)) * 5; // older generation wins, which is the whole point
  return s;
}
const FALLBACK_TRIES = 3;
async function fallbackModels(key: string, tried: string[], status: number) {
  const score = status === 429 ? scoreForQuota : scoreModel;
  const list = (await availableModels(key)).filter((m) => !tried.includes(m));
  return list.sort((a, b) => score(b) - score(a)).slice(0, FALLBACK_TRIES);
}

async function callGoogle(model: string, body: unknown, key: string) {
  return fetch(GOOGLE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
}

/* The app reads `error.message` out of whatever comes back, so failures raised HERE use
   Google's error shape too. */
const cors = (origin: string): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin || "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  /* Without this the app cannot read X-E26-Model, which records which model answered. */
  "Access-Control-Expose-Headers": "X-E26-Model",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});
const json = (obj: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
const fail = (status: number, message: string, origin: string) =>
  json({ error: { code: status, message } }, status, origin);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const allowed = originAllowed(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(allowed ? origin : "") });
  }
  if (req.method !== "POST") return fail(405, "This endpoint only accepts POST.", "");
  if (!allowed) return fail(403, "Origin not allowed.", "");
  if (await overLimit(req)) {
    return fail(429, "Too many plan reads from this connection. Give it a minute.", origin);
  }
  const key = await geminiKey();
  if (!key) return fail(500, "Proxy is missing its GEMINI_API_KEY secret.", origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "That request was too large to forward.", origin);

  let body: any;
  try { body = JSON.parse(raw); } catch { return fail(400, "Body was not valid JSON.", origin); }

  /* Diagnostic: {"list":true} answers with every model this key can call. */
  if (body && body.list === true) {
    const models = await availableModels(key);
    return json({ models, resolved: RESOLVED && RESOLVED.name }, 200, origin);
  }

  const model = String(body.model || "");
  if (!ALLOWED_MODELS.includes(model)) {
    return fail(400, `Model "${model}" is not allowed by this proxy.`, origin);
  }
  delete body.model;

  let upstream: Response;
  try {
    upstream = await callGoogle(model, body, key);
  } catch {
    return fail(502, "Couldn't reach Google from the proxy.", origin);
  }

  /* Retired (404), out of quota (429) or overloaded (500/503): all mean "this one NAME
     is not usable right now", which a different model fixes. Walk a short list. */
  const SWITCH_MODEL_ON = [404, 429, 500, 503];
  let served = model;
  if (SWITCH_MODEL_ON.includes(upstream.status)) {
    const tried = [model];
    for (const alt of await fallbackModels(key, tried, upstream.status)) {
      tried.push(alt);
      let retry: Response;
      try { retry = await callGoogle(alt, body, key); } catch { continue; }
      await upstream.body?.cancel();
      upstream = retry;
      served = alt;
      if (retry.ok) { RESOLVED = { name: alt, at: Date.now() }; break; }
      if (!SWITCH_MODEL_ON.includes(retry.status)) break;
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "X-E26-Model": served,
      ...cors(origin),
    },
  });
});
