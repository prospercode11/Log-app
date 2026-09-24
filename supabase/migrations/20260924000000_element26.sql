-- Element 26 backend: replaces the old Cloudflare KV store.
--
-- Every table is reachable ONLY through the edge functions, which run with the service
-- role. RLS is on with no policies, and the anon/authenticated roles get no grants, so
-- the public API key the dashboard hands out reads nothing here.

create table public.e26_accounts (
  id          text primary key check (id ~ '^E26-[0-9A-Z]{4}-[0-9A-Z]{4}$'),
  name        text not null default '',
  key_hash    text not null,
  created_at  bigint not null
);

create table public.e26_data (
  account_id  text primary key references public.e26_accounts(id) on delete cascade,
  saved_at    bigint not null,
  data        jsonb not null
);

create table public.e26_push (
  account_id  text primary key references public.e26_accounts(id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null default '',
  auth        text not null default '',
  ua          text not null default '',
  token       text not null unique,
  created_at  bigint not null
);

create table public.e26_sched (
  account_id  text not null references public.e26_accounts(id) on delete cascade,
  kind        text not null check (kind in ('train','bed','wake')),
  at          bigint not null,
  title       text not null,
  body        text not null default '',
  tag         text not null,
  primary key (account_id, kind)
);
create index e26_sched_at on public.e26_sched (at);

create table public.e26_pending (
  account_id  text primary key references public.e26_accounts(id) on delete cascade,
  queue       jsonb not null default '[]'::jsonb,
  expires_at  timestamptz not null
);

create table public.e26_push_result (
  account_id  text primary key references public.e26_accounts(id) on delete cascade,
  at          bigint not null,
  status      int not null,
  note        text not null default ''
);

create table public.e26_reports (
  id          text primary key,
  at          bigint not null,
  account_id  text,
  kind        text not null,
  rec         jsonb not null
);
create index e26_reports_at on public.e26_reports (at desc);

create table public.e26_rate (
  bucket      text primary key,
  count       int not null,
  expires_at  timestamptz not null
);

-- Server-side settings the functions read: VAPID keys, the cron secret, optionally the
-- Gemini key. Never exposed through the API.
create table public.e26_config (
  key    text primary key,
  value  text not null
);

do $$
declare t text;
begin
  foreach t in array array['e26_accounts','e26_data','e26_push','e26_sched','e26_pending',
                           'e26_push_result','e26_reports','e26_rate','e26_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Atomic counter for rate limits: returns the count INCLUDING this call.
create function public.e26_bump(p_bucket text, p_ttl_seconds int)
returns int language sql security definer set search_path = public as $$
  insert into e26_rate (bucket, count, expires_at)
  values (p_bucket, 1, now() + make_interval(secs => p_ttl_seconds))
  on conflict (bucket) do update set count = e26_rate.count + 1
  returning count;
$$;

-- Claims every due reminder in one statement. DELETE ... RETURNING is atomic, so two
-- overlapping cron runs can never send the same reminder twice.
create function public.e26_claim_due(p_now bigint)
returns table (account_id text, kind text, at bigint, title text, body text, tag text)
language sql security definer set search_path = public as $$
  delete from e26_sched s where s.at <= p_now
  returning s.account_id, s.kind, s.at, s.title, s.body, s.tag;
$$;

-- Appends messages to an account's pending queue, keeping the newest p_max.
create function public.e26_enqueue(p_account text, p_msgs jsonb, p_max int)
returns void language plpgsql security definer set search_path = public as $$
declare q jsonb;
begin
  select case when expires_at > now() then queue else '[]'::jsonb end into q
    from e26_pending where account_id = p_account for update;
  q := coalesce(q, '[]'::jsonb) || p_msgs;
  while jsonb_array_length(q) > p_max loop q := q - 0; end loop;
  insert into e26_pending (account_id, queue, expires_at)
  values (p_account, q, now() + interval '1 hour')
  on conflict (account_id) do update set queue = excluded.queue, expires_at = excluded.expires_at;
end $$;

-- Pops the first pending message for the account that owns this push token.
create function public.e26_pop_pending(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acct text; q jsonb; first jsonb;
begin
  select account_id into acct from e26_push where token = p_token;
  if acct is null then return null; end if;
  select queue into q from e26_pending
    where account_id = acct and expires_at > now() for update;
  if q is null or jsonb_array_length(q) = 0 then return '{}'::jsonb; end if;
  first := q -> 0;
  q := q - 0;
  if jsonb_array_length(q) = 0 then delete from e26_pending where account_id = acct;
  else update e26_pending set queue = q where account_id = acct; end if;
  return first;
end $$;

do $$
declare f text;
begin
  foreach f in array array['e26_bump(text,int)','e26_claim_due(bigint)',
                           'e26_enqueue(text,jsonb,int)','e26_pop_pending(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Housekeeping: expired rate buckets and pending queues.
create function public.e26_cleanup()
returns void language sql security definer set search_path = public as $$
  delete from e26_rate where expires_at < now();
  delete from e26_pending where expires_at < now();
$$;
revoke all on function public.e26_cleanup() from public, anon, authenticated;
