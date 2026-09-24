/**
 * Element 26 — offline service worker
 *
 * WHY THIS EXISTS. Every workout you log is already written to localStorage on the
 * device and nothing about logging needs a network. But without a service worker the
 * browser still has to FETCH the app before it can run it, so a gym with no signal meant
 * a blank ERR_INTERNET_DISCONNECTED page and no way to log the session sitting in front
 * of you. The data was never the problem; loading the thing that reads it was.
 *
 * WHAT IS CACHED, AND WHAT IS DELIBERATELY NOT
 *
 *   the app shell   index.html, the icons, the manifest. Precached on install, so the
 *                   very first launch after an update is already good for the next
 *                   session even if that one happened over wifi you no longer have.
 *   the fonts       Google's CSS and the font files behind it, cached as they are used.
 *                   The CSS variables all carry real fallback stacks, so a cold cache
 *                   offline degrades to system fonts rather than breaking; caching them
 *                   just means it looks right rather than merely working.
 *   NOT the APIs    The plan reader and the account service go straight to the network,
 *                   untouched. Both already fail gracefully and say so in words, and a
 *                   cached answer from either would be actively wrong: a stale training
 *                   plan, or somebody else's sync state.
 *
 * CACHE-FIRST, NOT NETWORK-FIRST, and that is the whole design decision. Network-first
 * would keep you on the newest build at the cost of waiting for the network on every
 * single launch — which is exactly the moment this is meant to protect, in a basement
 * gym on one bar. So the cached copy is served immediately and a fresh one is fetched in
 * the background for next time. The cost is that an update lands one launch late, which
 * is why the page is told when that happens instead of being left to wonder.
 */
const VERSION = "21.2";
const SHELL = "e26-shell-v" + VERSION;
const RUNTIME = "e26-runtime-v" + VERSION;

/* Relative, deliberately: this app is served from a project subpath
   (…github.io/ShowcaseE26/) and these resolve against the worker's own scope, so the
   same file works there, at a domain root, and on localhost with no edit. */
const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon180v2.png",
  "./icon192v2.png",
  "./icon512v2.png"
];

/* Hosts whose responses must always come from the network. Checked by hostname rather
   than by matching the whole URL, so a Worker moving to a custom domain is one line. */
const NEVER_CACHE = [
  "yqbqzuskzxcmsvgtfwsp.supabase.co",
  "generativelanguage.googleapis.com"
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event=>{
  event.waitUntil((async ()=>{
    const cache = await caches.open(SHELL);
    /* Individually rather than cache.addAll, because addAll is atomic: one 404 on one
       icon and the entire install rejects, leaving no offline support at all rather than
       slightly incomplete offline support. */
    await Promise.all(SHELL_URLS.map(u=>
      cache.add(new Request(u, {cache:"reload"})).catch(()=>{})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event=>{
  event.waitUntil((async ()=>{
    const names = await caches.keys();
    const stale = names.filter(n=> n.startsWith("e26-") && n !== SHELL && n !== RUNTIME);
    await Promise.all(stale.map(n=> caches.delete(n)));
    await self.clients.claim();
    /* Tell any open page that this was an UPDATE rather than a first install — the
       presence of an older cache is the only reliable signal of that from in here. */
    if(stale.length){
      const clients = await self.clients.matchAll({type:"window"});
      clients.forEach(c=> c.postMessage({type:"e26-updated", version:VERSION}));
    }
  })());
});

self.addEventListener("message", event=>{
  if(!event.data) return;
  if(event.data.type === "e26-skip-waiting") self.skipWaiting();
  /* WHICH BUILD IS ACTUALLY SERVING. Not always the one the page thinks: a cached shell
     is one launch behind by design, so "the app says 8.9 and the worker says 7.2" is the
     explanation for a whole class of "I updated and nothing changed". A bug report is
     exactly where that belongs, so the page can ask. */
  if(event.data.type === "e26-version"){
    /* Down the supplied port first. On a FIRST load there is no controller yet — the
       worker is active but has not taken over the page — so a reply addressed to
       event.source arrives nowhere, and the one launch where a version mismatch is most
       likely is the one launch that could not report it. A MessageChannel does not care
       whether anybody is controlling anything. */
    const reply = {type:"e26-version", version:VERSION};
    if(event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if(event.source) event.source.postMessage(reply);
  }
});

/* =====================================================================
   PUSH

   WHY THE PUSH CARRIES NO PAYLOAD. An encrypted Web Push payload is aes128gcm keyed off
   the subscription's p256dh/auth pair, and getting that wrong fails silently at the
   browser rather than at the sender. It is also the only part of this that would need
   the account service to hold key material belonging to a device. A payload-less push is
   a plain signed POST with no body: the push service wakes this worker, and the worker
   asks the account service what the notification actually says. The text therefore lives
   on the server for the few seconds between the two, and nowhere else.

   THE TOKEN IS NOT THE ACCOUNT KEY. The page writes a random per-subscription token into
   a Cache entry that only this worker's origin can read. It buys exactly one thing —
   "read and clear the notification waiting for me" — and it is minted and thrown away
   with the subscription. The recovery key never comes in here, so a worker that leaks
   cannot read a training log.

   A PUSH EVENT MUST END IN A NOTIFICATION. Every browser that implements this treats a
   push handled without showing one as abuse, and Safari in particular will drop the
   subscription for it. So every path below ends at showNotification(), including the
   ones where the fetch failed and we genuinely do not know what to say. */
const PUSH_API = "https://yqbqzuskzxcmsvgtfwsp.supabase.co/functions/v1/e26-accounts";
const PUSH_TOKEN_CACHE = "e26-push";
const PUSH_TOKEN_URL = "./__e26_push_token";

async function pushToken(){
  try{
    const cache = await caches.open(PUSH_TOKEN_CACHE);
    const hit = await cache.match(PUSH_TOKEN_URL);
    if(!hit) return "";
    return (await hit.text()).trim();
  }catch(e){ return ""; }
}

async function pendingNotification(){
  const t = await pushToken();
  if(!t) return null;
  try{
    const res = await fetch(PUSH_API + "/push/pending?t=" + encodeURIComponent(t), {cache:"no-store"});
    if(!res.ok) return null;
    const j = await res.json();
    if(j && j.title) return j;
  }catch(e){}
  return null;
}

self.addEventListener("push", event=>{
  event.waitUntil((async ()=>{
    let n = null;
    /* Nothing sends a payload today, but honouring one costs three lines and means a
       future sender can skip the round trip without another worker release. */
    try{ if(event.data) n = event.data.json(); }catch(e){ n = null; }
    if(!n || !n.title) n = await pendingNotification();
    /* THE LAST-RESORT TEXT, and it says something rather than saying the app's name.
       The device already tells you which app a notification came from — that line is the
       operating system's and cannot be removed — so spending the title on the same word
       is a notification whose entire content is "Element 26. Element 26." */
    if(!n || !n.title) n = {title:"Your next session is up", body:""};
    await self.registration.showNotification(String(n.title), {
      body: String(n.body || ""),
      /* One tag for the lot: a reminder that arrives while yesterday's is still on the
         lock screen should replace it, not stack. */
      tag: String(n.tag || "e26-reminder"),
      icon: "./icon192v2.png",
      badge: "./icon192v2.png",
      data: {url: String(n.url || "./")}
    });
  })());
});

self.addEventListener("notificationclick", event=>{
  event.notification.close();
  const want = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async ()=>{
    /* THE URL COMES FROM WHOEVER SENT THE PUSH, so it is resolved and then checked
       against this worker's own scope rather than trusted. A notification that can
       navigate somebody anywhere is a redirect with a badge on it; and the honest case
       is duller than the malicious one — the app is served from a project subpath, so a
       sender that innocently says "/" means the domain root, which is not the app. */
    let target = self.registration.scope;
    try{
      const u = new URL(want, self.registration.scope);
      if(u.href.indexOf(self.registration.scope) === 0) target = u.href;
    }catch(e){}
    const clients = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    /* Focus what is already open rather than opening a second copy. On iOS a Home Screen
       app has exactly one window and reopening it would restart an in-progress workout's
       view for no reason. */
    for(const c of clients){
      if(c.url.indexOf(self.registration.scope) === 0 && "focus" in c) return c.focus();
    }
    if(self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

/* Serve from cache, then refresh the cache in the background for next time.
   The FetchEvent is passed in rather than closed over so the background refresh can be
   handed to event.waitUntil(): returning the cached hit ends the event, and without
   waitUntil the browser is entitled to kill the worker before the refresh lands, which
   would quietly turn stale-while-revalidate into stale-forever. */
async function staleWhileRevalidate(event, request, cacheName){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const fetching = fetch(request).then(res=>{
    // opaque cross-origin responses are cacheable and still usable for fonts
    if(res && (res.ok || res.type === "opaque")) return cache.put(request, res.clone()).then(()=>res);
    return res;
  }).catch(()=> null);
  if(hit){ event.waitUntil(fetching); return hit; }
  const fresh = await fetching;
  if(fresh) return fresh;
  throw new Error("offline and not cached");
}

self.addEventListener("fetch", event=>{
  const req = event.request;
  if(req.method !== "GET") return;
  let url;
  try{ url = new URL(req.url); }catch(e){ return; }
  if(url.protocol !== "http:" && url.protocol !== "https:") return;

  // the plan reader and the account service are never intercepted
  if(NEVER_CACHE.indexOf(url.hostname) > -1) return;

  /* A navigation is the one request that MUST resolve to something, or the person gets
     the browser's offline page instead of their training log. Cache-first against the
     precached shell, with index.html as the fallback for any in-app URL. */
  if(req.mode === "navigate"){
    event.respondWith((async ()=>{
      const cache = await caches.open(SHELL);
      const cached = await cache.match("./index.html") || await cache.match("./");
      if(cached){
        /* TELL THE PAGE WHEN A NEW ONE ARRIVES.

           Cache-first means the version you are looking at is always the one from last
           launch, and the fresh copy this fetch stores only becomes visible the NEXT
           time the app is opened. That is the right trade for an app you use in a gym
           with no signal — but done silently it looks exactly like a change that never
           shipped, which is how "it didn't push" gets said about a push that worked.

           So the shell is compared with the one already cached, and when it differs the
           open page is told. It is not reloaded from under you: doing that mid-session
           would tear down an in-progress workout to deliver a cosmetic change. The page
           says a new version is ready and leaves the moment to you. */
        /* THE SNAPSHOT IS TAKEN HERE, NOT INSIDE THE FETCH, and that is the whole fix
           for "it says there is an update every single launch".

           `cached` is about to be handed to respondWith, and the browser consumes its
           body to render the page. The comparison below used to clone it AFTER the
           network round trip had come back — by which time the body was already spent,
           so the clone threw, the catch swallowed it, and `changed` kept its optimistic
           default of true. Every launch, on every build, the app announced an update to
           itself. Cloning before the response leaves this scope costs nothing and is the
           only moment the body is still untouched. */
        const snapshot = cached.clone();
        event.waitUntil(fetch(req).then(async res=>{
          if(!res || !res.ok) return;
          /* Copies for the cache, taken before anything reads a body: put() consumes the
             response it is given, and so does text(). */
          const forIndex = res.clone(), forRoot = res.clone();
          /* NOT BEING ABLE TO TELL IS NOT EVIDENCE OF AN UPDATE. If either body cannot be
             read the honest answer is silence — a notice that fires when the check fails
             is indistinguishable from one that fires when the check succeeds, which is
             how this got shipped in the first place. */
          let changed = false;
          try{
            const [was, now] = await Promise.all([snapshot.text(), res.text()]);
            changed = was !== now;
          }catch(e){ changed = false; }
          await cache.put("./index.html", forIndex);
          /* Both keys the lookup above will try, so the next launch cannot compare a
             fresh shell against a copy of the directory URL left over from install. */
          await cache.put("./", forRoot).catch(()=>{});
          if(changed){
            const clients = await self.clients.matchAll({type:"window"});
            clients.forEach(c=> c.postMessage({type:"e26-shell-updated"}));
          }
        }).catch(()=>{}));
        return cached;
      }
      try{ return await fetch(req); }
      catch(e){
        return new Response(
          "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
          + "<style>body{background:#0e0e10;color:#e8e6e1;font:16px/1.5 -apple-system,system-ui,sans-serif;"
          + "display:grid;place-items:center;height:100dvh;margin:0;text-align:center;padding:24px}</style>"
          + "<div><p>Element 26 hasn't finished saving itself for offline use yet.</p>"
          + "<p style='color:#9b9892'>Open it once with a connection and it will work without one after that.</p></div>",
          {headers:{"Content-Type":"text/html; charset=utf-8"}});
      }
    })());
    return;
  }

  if(FONT_HOSTS.indexOf(url.hostname) > -1){
    event.respondWith(staleWhileRevalidate(event, req, RUNTIME).catch(()=> fetch(req)));
    return;
  }
  if(url.origin === self.location.origin){
    event.respondWith(staleWhileRevalidate(event, req, SHELL).catch(()=> fetch(req)));
  }
});
