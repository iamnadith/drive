# Drive Backend Orchestrator

The Backend Orchestrator continuously synchronizes every configured Cloudflare account and R2 bucket from Cloudflare's account analytics. It also triggers panel-side migration/repair reconciliation and retention maintenance.

## Cloudflare Git deployment

Set these Cloudflare Git build values (they are also listed in `.env.example`):

```text
Root directory: workers/backend-orchestrator
Build command: npm run build
Deploy command: npm run deploy
```

Add these build variables/secrets:

- `PANEL_URL`: canonical Drive panel URL, for example `https://drive.example.com`
- `PANEL_SHARED_SECRET`: a random secret containing at least 24 characters

The panel may set `DISABLE_POSTGRES_SSL=true` when its PostgreSQL provider requires plaintext connections. The Worker disables SSL by default for Supabase hosts; all other providers use SSL unless this panel variable is explicitly true.

Those are the only values entered in Cloudflare. During deployment, the script authenticates to the panel configuration endpoint, fetches the PostgreSQL URL plus scan and retention settings, and injects them into the deployed Backend Orchestrator as encrypted Worker secrets. Runtime scan cycles use those injected bindings and do not fetch the database URL from the website.

The connected Cloudflare Worker project must be named `backend-orchestrator`. If Cloudflare says it expected another name such as `drive`, create or reconnect the build to the `backend-orchestrator` Worker before deploying; otherwise Cloudflare will override the configured name.

For local deployment, copy `.env.example` to `.env`, fill the two required values, and run `npm run deploy:local`. The `.env` file is ignored by Git. Cloudflare authentication for a local Wrangler session is handled separately by `wrangler login`; it is not a Backend Orchestrator runtime variable.

In Drive -> Settings -> Backend Orchestrator, enter the deployed URL and the same secret, then enable it and press **Run now**.

No PostgreSQL URL, Cloudflare account credentials, KV, D1, Queue, or Hyperdrive binding needs to be entered manually in Cloudflare. The deployment script authenticates to the panel and injects the PostgreSQL URL as an encrypted Worker secret. Runtime cycles read account credentials directly from PostgreSQL.

## Endpoints

- `GET /health`: safe public readiness result
- `GET /status`: authenticated detailed state
- `POST /run`: authenticated immediate cycle

The Backend Orchestrator cron runs every minute. It synchronizes storage statistics only for the one currently active Cloudflare account. It does not enumerate objects: Cloudflare's `r2StorageAdaptiveGroups` analytics dataset returns each bucket's object count and payload bytes regardless of whether the bucket contains ten objects or millions. The Worker writes bucket/account totals in batches and appends permanent history only when a count or byte value changes. Cloudflare notes that analytics can lag behind the latest R2 mutation, so a change is recorded when it appears in the metrics feed. The active account API token must include permission to read account analytics. Available and disabled accounts are not refreshed until an account becomes active.
