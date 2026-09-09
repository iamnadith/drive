# Migration Orchestrator

This autonomous Cloudflare Worker owns the migration-worker execution lane. It connects directly to PostgreSQL, converts the durable File Scanner inventory into disjoint 250-object jobs, recovers stale leases, fans GitHub dispatch intents through Cloudflare Queues, waits for independent File Scanner verification, retries bounded repair generations, and activates the verified target account.

It only selects migrations whose execution mode is `migration_workers`. It never selects migrations using the Cloudflare Super Slurper engine and does not modify the Backend Orchestrator. Coordination uses durable database rows plus authenticated wake-up calls to the File Scanner and Backend Orchestrator.

## Deploy

Set `PANEL_URL` and `MIGRATION_ORCHESTRATOR_SECRET` as build environment variables, then run:

```bash
npm ci
npm run deploy
```

The deploy script verifies Wrangler authentication, creates the dispatch queue and dead-letter queue when missing, calls the authenticated configuration endpoint once, and injects only `POSTGRES_URL` into Cloudflare. Runtime URL, secret, dispatch, and peer settings are loaded from PostgreSQL.

GitHub dispatch messages use one-message consumer invocations. Every dispatch has a durable database intent and unique worker instance ID; retries reconcile that ID before any external dispatch. Workers claim only scanner-generated batches with `FOR UPDATE SKIP LOCKED`, so two workers cannot own the same batch.

`GET /health` is a cheap liveness check. Authenticated `GET /status` reads durable database state and `POST /run` runs one lease-guarded cycle.
