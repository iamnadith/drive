# Drive Migration Worker

Standalone worker package for recovery, repair, and verification jobs.

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
- `DRIVE_AGENT_ID`
- `DRIVE_AGENT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The shorter names are also accepted: `SERVER_URL`, `AGENT_ID`, `AGENT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Non-secret tuning values can be added as repository variables, such as `COPY_CONCURRENCY`, `UPLOAD_QUEUE_SIZE`, and `UPLOAD_PART_SIZE_MB`.

When the panel dispatches a GitHub worker, it passes the server URL, agent id, and registration token as workflow inputs and synchronizes the `DRIVE_*` values as repository secrets.

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
- `DRIVE_REPAIR_JOB_ID`: optional exact job binding. GitHub Actions runs are automatically bound using `GITHUB_RUN_ID`.

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

- Identity is based on `agent id + token`, not IP/domain.
- The worker scans source and destination buckets live, repairs missing/mismatched files, and reports results back.
- This package is intended to live in its own repo.
