# Drive Agent Worker

Standalone worker package for recovery, repair, and verification jobs.

## Files

- `agent-worker.mjs`: worker runtime
- `package.json`: Node package manifest
- `.github/workflows/agent-worker.yml`: GitHub Actions runner

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

## GitHub Actions secrets

Set these repository secrets:

- `DRIVE_SERVER_URL`
- `DRIVE_AGENT_ID`
- `DRIVE_AGENT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

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

## Notes

- Identity is based on `agent id + token`, not IP/domain.
- The worker scans source and destination buckets live, repairs missing/mismatched files, and reports results back.
- This package is intended to live in its own repo.
