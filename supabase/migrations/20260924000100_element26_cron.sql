-- Reminders: every minute, if anything is scheduled, ask the accounts function to send
-- whatever has come due. The shared secret is read from e26_config when the job runs, so
-- it never appears in the job text. Seed it once:
--   insert into public.e26_config (key, value) values ('cron_secret', '<random hex>');
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.schedule(
  'e26-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://yqbqzuskzxcmsvgtfwsp.supabase.co/functions/v1/e26-accounts/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-e26-cron', (select value from public.e26_config where key = 'cron_secret')
    ),
    body    := '{}'::jsonb
  )
  where exists (select 1 from public.e26_sched);
  $$
);

-- Hourly housekeeping: expired rate-limit buckets and pending push queues.
select cron.schedule('e26-cleanup', '17 * * * *', 'select public.e26_cleanup()');
