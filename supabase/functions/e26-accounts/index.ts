/**
 * Element 26 — account service (Supabase Edge Function)
 *
 * Port of the old Cloudflare account Worker onto Supabase: same routes, same request and
 * response shapes, so the app talks to it unchanged. Storage is Postgres (see
 * supabase/migrations), reached with the service role; the tables have RLS on and no
 * grants for anon/authenticated, so nothing is readable except through this function.
 *
 * WHAT AN ACCOUNT IS
 *   id   E26-XXXX-XXXX. Names an account. Shown to the user.
 *   key  32 hex characters. Authenticates it. Stored only as a SHA-256 hash.
 *
 * Every private route goes through auth(), which needs both halves and derives the
 * account from the credential — never from a parameter.
 *
 * Deployed with verify_jwt = false: the Authorization header carries the E26 credential,
 * not a Supabase JWT, and auth() below is the check.
 *
 * Routes (relative to /functions/v1/e26-accounts):
 *   POST   /account          create        DELETE /account   delete (auth)
 *   POST   /session          verify id+key
 *   GET    /data             read blob     PUT    /data      write blob (auth)
 *   POST   /push/subscribe   POST /push/unsubscribe   POST /push/schedule   (auth)
 *   GET    /push/status (auth)             GET  /push/pending?t=<token>
 *   POST   /report (auth)
 *   POST   /cron             fire due reminders; called by pg_cron with x-e26-cron secret
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientIp, originAllowed } from "../_shared/origins.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const MAX_BODY = 4 * 1024 * 1024;
const NEW_ACCOUNTS_PER_HOUR = 20;
const ID_RE = /^E26-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const KEY_RE = /^[a-f0-9]{32,64}$/;
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const REPORT_MAX_TEXT = 2000;
const REPORT_MAX_ERRORS = 5;
const REPORTS_PER_HOUR = 6;
const REPORT_KINDS = ["bug", "idea", "other"];

const VAPID_TTL = "86400";
const SCHED_KINDS = ["train", "bed", "wake"];
const PEND_MAX = 4;
const SCHED_MAX_AHEAD = 60 * 24 * 3600 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const UA_LABELS = ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux", "Device"]
  .flatMap((d) => [d, d + " (installed)"]);
/* An endpoint is somewhere this service POSTs on a schedule, so it must be a real push
   service and not anywhere a caller likes. */
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /(^|\.)googleapis\.com$/,
  /(^|\.)mozilla\.com$/,
  /(^|\.)windows\.com$/,
  /(^|\.)microsoft\.com$/,
];

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": originAllowed(origin) ? origin : "null",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
  });
}
function randomFrom(alphabet: string, n: number): string {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
const newId = () => "E26-" + randomFrom(ID_ALPHABET, 4) + "-" + randomFrom(ID_ALPHABET, 4);
const newKey = () => randomFrom("abcdef0123456789", 32);
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/* Constant-time: an early return on the first wrong character leaks how much was right. */
function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function bump(bucket: string, ttlSeconds: number): Promise<number> {
  const { data, error } = await db.rpc("e26_bump", { p_bucket: bucket, p_ttl_seconds: ttlSeconds });
  if (error) throw error;
  return Number(data) || 0;
}

/* ---------------------------------------------------------------------------------
   CONFIG. VAPID keys and the cron secret live in public.e26_config (service-role only),
   with environment secrets taking precedence if set. Cached per isolate. */
let CONFIG: Record<string, string> | null = null;
let CONFIG_AT = 0;
async function config(): Promise<Record<string, string>> {
  if (CONFIG && Date.now() - CONFIG_AT < 5 * 60 * 1000) return CONFIG;
  const { data } = await db.from("e26_config").select("key,value");
  const c: Record<string, string> = {};
  for (const r of data || []) c[r.key] = r.value;
  const env = (k: string) => Deno.env.get(k) || "";
  c.vapid_public = env("VAPID_PUBLIC_KEY") || c.vapid_public || "";
  c.vapid_private = env("VAPID_PRIVATE_KEY") || c.vapid_private || "";
  c.vapid_subject = env("VAPID_SUBJECT") || c.vapid_subject || "https://element26.vercel.app";
  CONFIG = c;
  CONFIG_AT = Date.now();
  return c;
}
const pushConfigured = (c: Record<string, string>) => !!(c.vapid_public && c.vapid_private);

/* ---------------------------------------------------------------------------------
   WEB PUSH (VAPID, payload-less). The push carries no body; the service worker fetches
   the text from /push/pending with a token that reads one message and nothing else. */
function b64uFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uToBytes(str: string): Uint8Array {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uFromString = (str: string) => b64uFromBytes(new TextEncoder().encode(str));

async function vapidKey(c: Record<string, string>): Promise<CryptoKey> {
  const pub = b64uToBytes(c.vapid_public);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad VAPID public key");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      d: c.vapid_private.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
      x: b64uFromBytes(pub.slice(1, 33)),
      y: b64uFromBytes(pub.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}
async function vapidAuth(c: Record<string, string>, endpoint: string): Promise<string> {
  const head = b64uFromString(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64uFromString(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: c.vapid_subject,
  }));
  const input = head + "." + body;
  /* WebCrypto signs ECDSA as raw r||s, which is what Web Push wants. */
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, await vapidKey(c), new TextEncoder().encode(input),
  );
  return "vapid t=" + input + "." + b64uFromBytes(sig) + ", k=" + c.vapid_public;
}
function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
}
async function sendPush(c: Record<string, string>, endpoint: string) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": await vapidAuth(c, endpoint), "TTL": VAPID_TTL, "Urgency": "normal" },
  });
  await res.body?.cancel();
  return { gone: res.status === 404 || res.status === 410, status: res.status };
}
/* What the push service said last time, so "notifications don't arrive" is answerable. */
async function notePushResult(id: string, status: number, note: string) {
  await db.from("e26_push_result").upsert({ account_id: id, at: Date.now(), status, note: note || "" });
}
async function forgetPush(id: string) {
  await db.from("e26_push").delete().eq("account_id", id);
  await db.from("e26_sched").delete().eq("account_id", id);
  await db.from("e26_pending").delete().eq("account_id", id);
}

/* THE CRON. Claims every due reminder atomically (DELETE ... RETURNING), groups them by
   account, queues the text and sends one empty push per message. */
async function fireAllDue() {
  const c = await config();
  if (!pushConfigured(c)) return { sent: 0 };
  const { data: due, error } = await db.rpc("e26_claim_due", { p_now: Date.now() });
  if (error) throw error;
  const byAcct = new Map<string, Array<Record<string, unknown>>>();
  for (const r of due || []) {
    if (!byAcct.has(r.account_id)) byAcct.set(r.account_id, []);
    byAcct.get(r.account_id)!.push({ title: r.title, body: r.body, tag: r.tag || ("e26-" + r.kind) });
  }
  let sent = 0;
  const accounts = [...byAcct.entries()];
  /* Bounded concurrency across accounts, sequential within one. */
  for (let i = 0; i < accounts.length; i += 10) {
    await Promise.all(accounts.slice(i, i + 10).map(async ([id, msgs]) => {
      try {
        const { data: sub } = await db.from("e26_push").select("endpoint").eq("account_id", id).maybeSingle();
        if (!sub || !sub.endpoint) return;
        await db.rpc("e26_enqueue", { p_account: id, p_msgs: msgs, p_max: PEND_MAX });
        for (let k = 0; k < msgs.length; k++) {
          try {
            const r = await sendPush(c, sub.endpoint);
            await notePushResult(id, r.status, "");
            if (r.gone) { await forgetPush(id); return; }
            sent++;
          } catch (e) {
            await notePushResult(id, 0, String((e as Error)?.message || e).slice(0, 120));
            return;
          }
        }
      } catch (_) { /* one account's failure must not stop the others */ }
    }));
  }
  await db.rpc("e26_cleanup");
  return { sent };
}

/* ---------------------------------------------------------------------------------
   THE ONLY WAY TO IDENTIFY A CALLER. The account falls out of the credential. */
type Who = { id: string; name: string };
async function auth(req: Request): Promise<Who | null> {
  const header = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(E26-[0-9A-Z]{4}-[0-9A-Z]{4})\.([a-f0-9]{32,64})$/.exec(header.trim());
  if (!m) return null;
  return verify(m[1], m[2]);
}
async function verify(id: string, key: string): Promise<Who | null> {
  const { data } = await db.from("e26_accounts").select("id,name,key_hash").eq("id", id).maybeSingle();
  if (!data) return null;
  if (!sameSecret(await sha256(key), data.key_hash || "")) return null;
  return { id: data.id, name: data.name || "" };
}
async function body(req: Request): Promise<Record<string, any>> {
  try { return (await req.json()) || {}; } catch { return {}; }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const url = new URL(req.url);
  /* The function sees its own name at the start of the path; strip it (and anything
     before it) so routes read the same as they did on the Worker. */
  const path = url.pathname.replace(/^.*?\/e26-accounts(?=\/|$)/, "").replace(/\/+$/, "") || "/";

  /* The cron comes from the database, not a browser, so it has no Origin; it proves
     itself with the shared secret instead. */
  if (path === "/cron" && req.method === "POST") {
    const c = await config();
    const given = req.headers.get("x-e26-cron") || "";
    if (!c.cron_secret || !sameSecret(given, c.cron_secret)) return json({ error: "forbidden" }, 403, "");
    try { return json({ ok: true, ...(await fireAllDue()) }, 200, ""); }
    catch (e) { return json({ error: String((e as Error)?.message || e) }, 500, ""); }
  }

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (!originAllowed(origin)) return json({ error: "forbidden" }, 403, origin);

  try {
    /* CREATE. The id and key are minted here, never accepted from the caller. The key is
       returned exactly once. */
    if (path === "/account" && req.method === "POST") {
      const seen = await bump("new:" + clientIp(req) + ":" + Math.floor(Date.now() / 3600000), 7200);
      if (seen > NEW_ACCOUNTS_PER_HOUR) {
        return json({ error: "too many accounts created, try again later" }, 429, origin);
      }
      const b = await body(req);
      const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 32);
      const key = newKey();
      const keyHash = await sha256(key);
      for (let i = 0; i < 5; i++) {
        const id = newId();
        const { error } = await db.from("e26_accounts")
          .insert({ id, name, key_hash: keyHash, created_at: Date.now() });
        if (!error) return json({ id, key, name }, 201, origin);
        if (error.code !== "23505") throw error;   // anything but an id collision
      }
      return json({ error: "try again" }, 500, origin);
    }

    /* VERIFY. "No such id" and "wrong key" are the same answer. */
    if (path === "/session" && req.method === "POST") {
      const b = await body(req);
      const id = String(b.id || "").trim().toUpperCase();
      const key = String(b.key || "").trim().toLowerCase();
      if (!ID_RE.test(id) || !KEY_RE.test(key)) return json({ error: "unauthorized" }, 401, origin);
      const who = await verify(id, key);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      return json({ ok: true, name: who.name }, 200, origin);
    }

    /* DELETE. Everything the account owns goes with it (foreign keys cascade). */
    if (path === "/account" && req.method === "DELETE") {
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      await db.from("e26_accounts").delete().eq("id", who.id);
      return json({ ok: true }, 200, origin);
    }

    /* THE DATA. One blob per account. */
    if (path === "/data") {
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      if (req.method === "GET") {
        const { data } = await db.from("e26_data").select("saved_at,data").eq("account_id", who.id).maybeSingle();
        if (!data) return json({ savedAt: 0, data: null }, 200, origin);
        return json({ savedAt: Number(data.saved_at), data: data.data }, 200, origin);
      }
      if (req.method === "PUT") {
        const len = Number(req.headers.get("Content-Length") || 0);
        if (len > MAX_BODY) return json({ error: "too large" }, 413, origin);
        const text = await req.text();
        if (text.length > MAX_BODY) return json({ error: "too large" }, 413, origin);
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return json({ error: "bad json" }, 400, origin); }
        if (!parsed || typeof parsed !== "object" || !parsed.data) return json({ error: "bad body" }, 400, origin);
        const { error } = await db.from("e26_data").upsert({
          account_id: who.id,
          saved_at: Number(parsed.savedAt) || Date.now(),
          data: parsed.data,
        });
        if (error) throw error;
        return json({ ok: true }, 200, origin);
      }
      return json({ error: "method not allowed" }, 405, origin);
    }

    /* PUSH: the service worker's one read, authorised by the subscription token. */
    if (path === "/push/pending" && req.method === "GET") {
      const t = String(url.searchParams.get("t") || "").toLowerCase();
      if (!TOKEN_RE.test(t)) return json({ error: "unauthorized" }, 401, origin);
      const { data, error } = await db.rpc("e26_pop_pending", { p_token: t });
      if (error) throw error;
      if (data === null) return json({ error: "unauthorized" }, 401, origin);
      return json(data || {}, 200, origin);
    }

    if (path === "/push/subscribe" && req.method === "POST") {
      if (!pushConfigured(await config())) return json({ error: "push not configured" }, 501, origin);
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      const b = await body(req);
      const endpoint = String(b.endpoint || "");
      if (!endpointAllowed(endpoint)) return json({ error: "bad endpoint" }, 400, origin);
      const b64u = (v: unknown, max: number) => {
        const t = String(v || "");
        return /^[A-Za-z0-9_-]+$/.test(t) && t.length <= max ? t : "";
      };
      const ua = UA_LABELS.indexOf(String(b.ua || "")) > -1 ? String(b.ua) : "";
      /* One installed app per account: resubscribing replaces. */
      await forgetPush(who.id);
      const token = randomFrom("abcdef0123456789", 32);
      const { error } = await db.from("e26_push").insert({
        account_id: who.id,
        endpoint,
        p256dh: b64u(b.keys && b.keys.p256dh, 120),
        auth: b64u(b.keys && b.keys.auth, 48),
        ua,
        token,
        created_at: Date.now(),
      });
      if (error) throw error;
      return json({ ok: true, token }, 200, origin);
    }

    if (path === "/push/status" && req.method === "GET") {
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      const [{ data: last }, { data: sub }] = await Promise.all([
        db.from("e26_push_result").select("at,status,note").eq("account_id", who.id).maybeSingle(),
        db.from("e26_push").select("endpoint").eq("account_id", who.id).maybeSingle(),
      ]);
      let host = "";
      try { host = sub ? new URL(sub.endpoint).hostname : ""; } catch { /* keep empty */ }
      return json({
        ok: true,
        subscribed: !!sub,
        host,
        last: last ? { at: Number(last.at), status: last.status, note: last.note } : null,
      }, 200, origin);
    }

    if (path === "/push/unsubscribe" && req.method === "POST") {
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      await forgetPush(who.id);
      return json({ ok: true }, 200, origin);
    }

    /* SCHEDULE. The app posts the whole set every time; a kind it leaves out is deleted. */
    if (path === "/push/schedule" && req.method === "POST") {
      if (!pushConfigured(await config())) return json({ error: "push not configured" }, 501, origin);
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      const b = await body(req);
      const items: any[] = Array.isArray(b.items) ? b.items : [];
      const kept: Array<{ kind: string; at: number }> = [];
      for (const kind of SCHED_KINDS) {
        const it = items.find((x) => x && x.kind === kind);
        const at = it ? Math.round(Number(it.at)) : NaN;
        if (!it || !isFinite(at) || at > Date.now() + SCHED_MAX_AHEAD) {
          await db.from("e26_sched").delete().eq("account_id", who.id).eq("kind", kind);
          continue;
        }
        const { error } = await db.from("e26_sched").upsert({
          account_id: who.id,
          kind,
          at,
          title: String(it.title || "Reminder").slice(0, 80),
          body: String(it.body || "").slice(0, 200),
          tag: "e26-" + kind,
        });
        if (error) throw error;
        kept.push({ kind, at });
      }
      return json({ ok: true, scheduled: kept }, 200, origin);
    }

    /* REPORT A PROBLEM. Everything in it is client input: capped and shaped. */
    if (path === "/report" && req.method === "POST") {
      const who = await auth(req);
      if (!who) return json({ error: "unauthorized" }, 401, origin);
      const seen = await bump("rep:" + who.id + ":" + Math.floor(Date.now() / 3600000), 7200);
      if (seen > REPORTS_PER_HOUR) return json({ error: "too many reports, try again later" }, 429, origin);

      const b = await body(req);
      const text = String(b.text || "").trim().slice(0, REPORT_MAX_TEXT);
      if (!text) return json({ error: "say what happened" }, 400, origin);

      const str = (v: unknown, n: number) => String(v == null ? "" : v).slice(0, n);
      const at = Date.now();
      const rec: Record<string, any> = {
        at,
        accountId: who.id,
        name: str(who.name, 32),
        kind: REPORT_KINDS.indexOf(String(b.kind)) > -1 ? String(b.kind) : "bug",
        text,
        app: str(b.app, 16),
        sw: str(b.sw, 16),
        ua: str(b.ua, 300),
        installed: !!b.installed,
        tab: str(b.tab, 24),
        diag: {},
        errors: [],
        status: "new",
      };
      const diag = b.diag && typeof b.diag === "object" ? b.diag : {};
      Object.keys(diag).slice(0, 20).forEach((k) => {
        const v = diag[k];
        rec.diag[k.slice(0, 24)] = typeof v === "number" || typeof v === "boolean" ? v : str(v, 60);
      });
      if (Array.isArray(b.errors)) {
        rec.errors = b.errors.slice(0, REPORT_MAX_ERRORS).map((e: any) => ({
          msg: str(e && e.msg, 300),
          src: str(e && e.src, 200),
          line: Number(e && e.line) || 0,
          stack: str(e && e.stack, 1200),
          at: Number(e && e.at) || 0,
        }));
      }
      const id = "report:" + String(at).padStart(15, "0") + ":" + randomFrom("abcdef0123456789", 8);
      const { error } = await db.from("e26_reports").insert({ id, at, account_id: who.id, kind: rec.kind, rec });
      if (error) throw error;
      return json({ ok: true, id }, 201, origin);
    }

    return json({ error: "not found" }, 404, origin);
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500, origin);
  }
});
