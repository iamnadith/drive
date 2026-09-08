# Drive Migration Worker

Standalone worker package for full migrations, recovery, repair, and verification jobs.

## Files

- `migration-worker.mjs`: worker runtime
- `package.json`: Node package manifest
- `.github/workflows/migration-worker.yml`: GitHub Actions runner

## Required server-side support

This worker expects these APIs to exist on your Drive app:

- `POST /api/workers/:id/heartbeat`
- `POST /api/workers/:id/claim-job`
- `POST /api/workers/:id/jobs/:jobId`

It also expects repair jobs to be created in the app database.

## Local run

```bash
npm install
npm start -- --server-url https://your-app.example.com --agent-id YOUR_AGENT_ID --token YOUR_TOKEN
```

The same values can be supplied as environment variables instead of command-line arguments:

```bash
SERVER_URL=https://your-app.example.com AGENT_ID=YOUR_AGENT_ID TOKEN=YOUR_TOKEN npm start
```

PowerShell:

```powershell
$env:SERVER_URL="https://your-app.example.com"
$env:AGENT_ID="YOUR_AGENT_ID"
$env:TOKEN="YOUR_TOKEN"
npm start
```

## GitHub Actions configuration

The root workflow at `.github/workflows/migration-worker.yml` accepts runtime values from the Drive panel and also detects repository secrets or repository variables.

Recommended repository secrets:

- `DRIVE_SERVER_URL`
- `DRIVE_AGENT_ID` (legacy fallback; the workflow dispatch input is preferred)
- `DRIVE_WORKER_SHARED_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The shorter names are also accepted: `SERVER_URL`, `AGENT_ID`, `AGENT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Non-secret tuning values can be added as repository variables, such as `COPY_CONCURRENCY`, `UPLOAD_QUEUE_SIZE`, and `UPLOAD_PART_SIZE_MB`.

When the panel dispatches a GitHub worker, it passes the server URL and unique agent id as workflow inputs and synchronizes the same `DRIVE_WORKER_SHARED_SECRET` to every selected worker repository. The shared secret authenticates the worker; the agent id keeps each concurrent worker separately identifiable. A worker claims one durable object-shard job at a time and keeps polling for more shards. Every shard spans all selected buckets and uses a stable bucket/key hash, so an object has one queue owner at a time and workers do not duplicate each other's file work.

## Optional direct Supabase connection

The worker already works through the website API only.

If you also want the worker to mirror heartbeat/job updates directly into Supabase, provide:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Example:

```bash
npm start -- \
  --server-url https://your-app.example.com \
  --agent-id YOUR_AGENT_ID \
  --token YOUR_TOKEN \
  --supabase-url https://xyzcompany.supabase.co \
  --supabase-service-role-key YOUR_SERVICE_ROLE_KEY
```

If your website and worker use the same project, use the same `SUPABASE_URL` and service role key that the main app uses.

## Performance tuning

The worker copies multiple objects at once and uses multipart upload concurrency for larger files.

Optional environment variables:

- `COPY_CONCURRENCY`: number of objects copied in parallel. Default: `8`.
- `UPLOAD_QUEUE_SIZE`: multipart upload parts per object. Default: `4`.
- `UPLOAD_PART_SIZE_MB`: multipart part size in MB. Default: `16`.
- `S3_RETRIES`: retry attempts for R2/S3 operations. Default: `3`.
- `HEARTBEAT_MS`: worker heartbeat interval. Default: `20000`; heartbeat
  requests are bounded so a network outage cannot hold a lease renewal for
  several minutes.
- `MAX_OBJECTS`: maximum objects inventoried per bucket. Default: `200000`; if
  the limit would truncate a listing, the worker fails the shard explicitly
  and asks you to increase the value instead of silently completing a partial
  migration.
- `DRIVE_MIGRATION_ID`: optional migration scope used by pool workers when a
  workflow is started manually. GitHub dispatches receive this automatically.
- `DRIVE_REPAIR_JOB_ID`: optional exact job binding. GitHub Actions runs are automatically bound using `GITHUB_RUN_ID`.
- `EXIT_AFTER_JOB`: pool workers default to `false`, so a GitHub or self-hosted
  process keeps polling and can claim successive shards. A pool worker exits
  cleanly when the panel reports that the current generation is fully
  terminal. A standalone GitHub Actions repair run defaults to one-shot; set
  this to `false` when intentionally keeping it alive, or to `true` for any
  deliberately one-shot run. The bundled workflow sets this automatically
  from the presence of an exact repair-job input; `EXIT_AFTER_JOB` repository
  variable can override it.

For faster hosts, start with:

```bash
COPY_CONCURRENCY=16 UPLOAD_QUEUE_SIZE=4 npm start
```

PowerShell:

```powershell
$env:COPY_CONCURRENCY="16"; $env:UPLOAD_QUEUE_SIZE="4"; npm start
```

If Cloudflare/R2 starts throttling or requests fail, lower `COPY_CONCURRENCY`.

## Notes

- Identity is based on `agent id + the panel's shared worker secret`, not IP/domain. Legacy per-agent tokens remain accepted for existing installations.
- The worker scans source and destination buckets live, repairs missing/mismatched files, and reports results back.
- A migration worker job is a shard of the complete migration, not a bucket assignment. The panel creates a configurable shard count (8-128); dispatch at least as many workers as useful and each worker claims the next unclaimed shard. Stable ownership keys and durable leases prevent duplicate claims during normal operation; expired leases are requeued for crash recovery.
- Pool workers send the migration scope on every claim request and keep the process alive until the queue is empty. The panel must treat a pool claim as a migration-scoped claim even after the same GitHub run has already claimed a previous shard.
- This package is intended to live in its own repo.
