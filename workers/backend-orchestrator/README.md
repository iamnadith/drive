# Drive Backend Orchestrator

The Backend Orchestrator continuously synchronizes every configured Cloudflare account and R2 bucket using bounded, resumable pages. It also triggers panel-side migration/repair reconciliation and retention maintenance.

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

Those are the only values entered in Cloudflare. During deployment, the script authenticates to the panel configuration endpoint, fetches the PostgreSQL URL plus scan and retention settings, and injects them into the deployed Backend Orchestrator as encrypted Worker secrets. Runtime scan cycles use those injected bindings and do not fetch the database URL from the website.

The connected Cloudflare Worker project must be named `backend-orchestrator`. If Cloudflare says it expected another name such as `drive`, create or reconnect the build to the `backend-orchestrator` Worker before deploying; otherwise Cloudflare will override the configured name.

For local deployment, copy `.env.example` to `.env`, fill the two required values, and run `npm run deploy:local`. The `.env` file is ignored by Git. Cloudflare authentication for a local Wrangler session is handled separately by `wrangler login`; it is not a Backend Orchestrator runtime variable.

In Drive -> Settings -> Backend Orchestrator, enter the deployed URL and the same secret, then enable it and press **Run now**.

No PostgreSQL URL, Cloudflare account credentials, KV, D1, Queue, or Hyperdrive binding is configured in Cloudflare. The Backend Orchestrator authenticates to the panel, fetches the current PostgreSQL URL at runtime, and reads account credentials directly from PostgreSQL.

## Endpoints

- `GET /health`: safe public readiness result
- `GET /status`: authenticated detailed state
- `POST /run`: authenticated immediate cycle

The Backend Orchestrator cron runs every minute. Each cycle processes a bounded number of R2 list pages, stores its cursor in PostgreSQL, and resumes on the next invocation.
