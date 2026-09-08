# Migration Orchestrator

This Cloudflare Worker is the scheduler and recovery boundary for Drive's
GitHub/self-hosted migration worker pool. Every minute it calls the panel's
authenticated `/api/internal/migration-orchestrator/tick` endpoint. The panel
owns the durable database transaction: it materializes idempotent shared
object-shard jobs spanning every migration bucket, requeues jobs whose worker
lease expired, reconciles worker runs, and advances migration state.

The existing Cloudflare Super Slurper migration lane is independent. The
orchestrator only processes migrations created with the `migration_workers`
execution mode.

## Deploy

```bash
npm install
npx wrangler secret put PANEL_SHARED_SECRET
npx wrangler secret put PANEL_URL
npm run deploy
```

Use the same random secret in the panel's Migration Orchestrator settings and
as `PANEL_SHARED_SECRET`. Use 24-512 characters; the panel URL must be HTTPS
in production.

## Endpoints

- `GET /health` is public and contains no credentials.
- `GET /status` requires `Authorization: Bearer <PANEL_SHARED_SECRET>`.
- `POST /run` requires the same header and runs one guarded cycle.

The in-flight guard makes a manual run and a cron tick share one cycle instead
of creating duplicate database work.

The free-tier Worker is only a scheduler: each cycle makes one bounded,
authenticated request to the panel and never copies object bytes. Queue rows,
shard ownership keys, and worker leases live in the panel database. If a cron
invocation or request is terminated, the next cycle resumes by reusing the
same shard rows and requeueing only expired leases. Concurrent cycles are
safe because shard creation is unique-key guarded and claims are atomic.
