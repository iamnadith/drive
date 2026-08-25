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

For local deployment, copy `.env.example` to `.env`, fill the values, and run `npm run deploy`. The `.env` file is ignored by Git.

In Drive -> Settings -> Backend Orchestrator, enter the deployed URL and the same secret, then enable it and press **Run now**.

No PostgreSQL URL, Cloudflare account credentials, KV, D1, Queue, or Hyperdrive binding is configured in Cloudflare. The Backend Orchestrator authenticates to the panel, fetches the current PostgreSQL URL at runtime, and reads account credentials directly from PostgreSQL.

## Endpoints

- `GET /health`: safe public readiness result
- `GET /status`: authenticated detailed state
- `POST /run`: authenticated immediate cycle

The Backend Orchestrator cron runs every two minutes. Each cycle processes a bounded number of R2 list pages, stores its cursor in PostgreSQL, and resumes on the next invocation.
