# Migration Orchestrator

This autonomous Cloudflare Worker owns the migration-worker execution lane. It connects directly to PostgreSQL, materializes shared object-shard jobs spanning every migration bucket, recovers stale leases, dispatches enrolled GitHub workers, waits for File Scanner verification, retries bounded repair generations, and activates the verified target account.

It only selects migrations whose execution mode is `migration_workers`. It never selects migrations using the Cloudflare Super Slurper engine and does not modify the Backend Orchestrator. Coordination uses durable database rows plus authenticated wake-up calls to the File Scanner and Backend Orchestrator.

## Deploy

Set `PANEL_URL` and `PANEL_SHARED_SECRET` as build environment variables, then run:

```bash
npm ci
npm run deploy
```

The deploy script calls the authenticated configuration endpoint once and injects only `POSTGRES_URL` into Cloudflare. Runtime URL, secret, dispatch, and peer settings are loaded from PostgreSQL.

`GET /health` is a cheap liveness check. Authenticated `GET /status` reads durable database state and `POST /run` runs one lease-guarded cycle.
