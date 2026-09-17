# Drive Migration Worker

Standalone worker package for full migrations, recovery, repair, and verification jobs.

## Files

- `migration-worker.mjs`: worker runtime
- `package.json`: Node package manifest
- `.github/workflows/migration-worker.yml`: GitHub Actions runner

## Runtime configuration

The worker requires the Migration Orchestrator URL (`SERVER_URL`) and the shared Migration Worker secret (`TOKEN`). GitHub dispatch also supplies `AGENT_ID`, `DRIVE_MIGRATION_ID`, and a unique `WORKER_INSTANCE_ID`.

The worker communicates with the Migration Orchestrator for registration, fenced job claims, heartbeat/lease renewal, cancellation, progress, and results. It does not connect to PostgreSQL and must never receive `POSTGRES_URL` or a PostgreSQL SSL setting. Configure `POSTGRES_URL` and `DISABLE_POSTGRES_SSL` on the Migration Orchestrator; the Orchestrator owns database connectivity and worker dispatch.

## Local run

```bash
npm install
npm start -- --server-url https://YOUR-MIGRATION-ORCHESTRATOR --token YOUR_SHARED_SECRET --agent-id YOUR_AGENT_ID
```

The same values can be supplied as environment variables instead of command-line arguments:

```bash
SERVER_URL=https://YOUR-MIGRATION-ORCHESTRATOR TOKEN=YOUR_SHARED_SECRET AGENT_ID=YOUR_AGENT_ID npm start
```

PowerShell:

```powershell
$env:SERVER_URL="https://YOUR-MIGRATION-ORCHESTRATOR"
$env:TOKEN="YOUR_SHARED_SECRET"
$env:AGENT_ID="YOUR_AGENT_ID"
npm start
```

## GitHub Actions configuration

The root workflow at `.github/workflows/migration-worker.yml` accepts runtime values from the Drive panel and also detects repository secrets or repository variables.

Required repository secrets:

- `DRIVE_MIGRATION_ORCHESTRATOR_URL`
- `DRIVE_WORKER_SHARED_SECRET`

The agent id is passed per dispatch, so one GitHub account and repository can host many separately identified worker registrations. Non-secret tuning values can be added as repository variables, such as `COPY_CONCURRENCY`, `UPLOAD_QUEUE_SIZE`, and `UPLOAD_PART_SIZE_MB`.

When the panel dispatches a GitHub worker, it synchronizes only the Orchestrator URL and shared worker secret. Database URL and SSL configuration remain on the Migration Orchestrator and are never exposed to GitHub Actions workers. The agent id keeps concurrent workers separately identifiable. A per-claim UUID fences stale processes after recovery. Each worker claims one scanner-generated per-file job at a time and keeps polling for more work. The generation-scoped unique work key gives every source object one durable queue record.

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
- `MAX_OBJECTS`: maximum objects inventoried per bucket. Default: `2000000`; if
  the limit would truncate an assigned inventory, the worker fails the file job explicitly
  and asks you to increase the value instead of silently completing a partial
  migration.
- `DRIVE_MIGRATION_ID`: optional migration scope used by pool workers when a
  workflow is started manually. GitHub dispatches receive this automatically.
- `DRIVE_REPAIR_JOB_ID`: optional exact job binding. GitHub Actions runs are automatically bound using `GITHUB_RUN_ID`.
- `EXIT_AFTER_JOB`: pool workers default to `false`, so a GitHub or self-hosted
  process keeps polling and can claim successive file jobs. A pool worker exits
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
- A migration worker job represents one scanner-indexed source file, not a bucket assignment. Dispatch as many configured workers as useful and each worker claims the next unclaimed file. Generation-scoped ownership keys and durable leases prevent duplicate claims; expired leases are requeued for crash recovery.
- Pool workers send the migration scope on every claim request and keep the process alive until the queue is empty. The panel treats every claim as migration-scoped even after the same GitHub run has already completed a previous file.
- This package is intended to live in its own repo.
