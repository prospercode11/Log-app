# Element 26 backend (Supabase)

Project: `element26` (`yqbqzuskzxcmsvgtfwsp`). Two Edge Functions and a handful of tables.

| Piece | What it does |
| --- | --- |
| `functions/e26-accounts` | Accounts (`E26-XXXX-XXXX` id + recovery key), cloud sync of the training log, push reminders, bug reports. `E26_API` in `index.html` points here. |
| `functions/e26-gemini` | Plan-reader proxy: holds the Gemini API key and forwards the app's requests to Google. `AI_PROXY` in `index.html` points here. |
| `functions/_shared/origins.ts` | Which sites may call the functions. Add your domain here if you host the app somewhere new, then redeploy both functions. |
| `migrations/` | Tables (`e26_*`), helper SQL functions, and the pg_cron jobs. |

All `e26_*` tables have RLS on with no policies and no grants to `anon`/`authenticated`:
only the functions (service role) can read or write them.

## Secrets

Server-side settings live in `public.e26_config` (service-role only) or as Edge Function
secrets (Dashboard → Edge Functions → Secrets), with the function secret winning:

| Key in `e26_config` | Function secret | Purpose |
| --- | --- | --- |
| `gemini_api_key` | `GEMINI_API_KEY` | **Required for plan import.** Get one at https://aistudio.google.com/apikey |
| `vapid_public` / `vapid_private` | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Push reminders. The public half is also `VAPID_PUBLIC` in `index.html`. |
| `vapid_subject` | `VAPID_SUBJECT` | Contact URL/mailto sent to push services. Defaults to the app URL. |
| `cron_secret` | – | Shared secret between pg_cron and `/cron`. |

## Deploy changes

With the Supabase CLI, from the repo root:

```bash
supabase link --project-ref yqbqzuskzxcmsvgtfwsp
supabase functions deploy e26-accounts --no-verify-jwt
supabase functions deploy e26-gemini --no-verify-jwt
supabase db push            # new migrations only
```

## Check it

```bash
# refused: no Origin
curl -i -X POST https://yqbqzuskzxcmsvgtfwsp.supabase.co/functions/v1/e26-accounts/account
# creates an account
curl -s -X POST https://yqbqzuskzxcmsvgtfwsp.supabase.co/functions/v1/e26-accounts/account \
  -H 'Origin: http://localhost:8000' -H 'Content-Type: application/json' -d '{"name":"Test"}'
```
