This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Database schema during builds

The build now applies the idempotent `supabase/drive_schema.sql` before Next.js compiles. Configure `POSTGRES_URL` (or `POSTGRES_URL_NON_POOLING`) in the Vercel build environment, and keep the existing `POSTGRES_SSL*` settings when required by your database. The build fails before deployment if the schema cannot be prepared, preventing first-request schema races.

Run the schema step by itself with `npm run db:schema`. `DRIVE_SCHEMA_DRY_RUN=1` validates configuration without changing the database. `DRIVE_SKIP_SCHEMA_BUILD=1` is an explicit emergency escape hatch; production builds should leave it unset.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Migration Verification (Cloudflare R2)

This project runs a post-copy verification step for each migrated bucket once Cloudflare Super Slurper marks it as `completed`:

- Verifies every source object exists in destination (key + size).
- Optionally hashes small objects (`sha256-small`) to catch same-size corruption.
- Tracks progress in each migration item's `progress.verify` so repeated `/sync` polls can continue verification without timeouts.

Migration creation options (POST `/api/migrations`):

- `verifyAfterCopy` (boolean, default `true`)
- `verifyStrictDestination` (boolean, default `false`)
- `verifyMode` (`"keys-and-size"` | `"sha256-small"`, default `"keys-and-size"`)
- `verifyHashMaxBytes` (number, bytes; used when `verifyMode="sha256-small"`)

## Worker packages

- `workers/backend-orchestrator`: Cloudflare-deployed scheduler for resumable account and bucket statistics, retention, and panel reconciliation. Its `.env.example` contains the required variables and Git build commands.
- `workers/migration-worker`: Node.js migration, verification, and repair processor used by `.github/workflows/migration-worker.yml`.

## Media delivery CORS

The stable object endpoint (`/storage/{bucket}/{key}`) redirects each `GET` and `HEAD` request to a freshly signed R2 URL and marks that redirect `no-store`. This keeps manifests and segments on stable Drive URLs while avoiding Drive proxying media bytes.

For legacy/unconfigured bucket assignments, set `DRIVE_MEDIA_ALLOWED_ORIGINS` on the Drive deployment to a comma-separated list of exact panel origins, for example:

```text
DRIVE_MEDIA_ALLOWED_ORIGINS=https://panel.example.com,https://staging.panel.example.com
```

Set the legacy value to `*` when any browser origin should be allowed.

Each active-account/bucket pair can instead persist Drive delivery settings through either the project-buckets or global bucket-settings API. Drive public access is deliberately separate from Cloudflare's Public development URL and defaults to enabled for compatibility. When Drive public access is disabled, `GET` and `HEAD` on the stable endpoint require a project API key for the one project assigned to that bucket; a CORS origin never grants object access.

`mediaAllowedOrigins: null` uses the legacy deployment value, `[]` denies cross-origin browser reads, and `["*"]` selects **Any origin**. Any-origin CORS is useful for intentionally public media, but private buckets still require project API authorization. Saving origins automatically merges and verifies the dedicated `drive-media-delivery` rule in R2 while preserving unrelated CORS rules; no manual R2 CORS update is required.

When a browser sends an `Origin` header, Drive also enforces the effective project-plus-bucket origin list on the server before issuing or redirecting to a signed object URL. A project API key does not bypass this origin check. Requests without `Origin` are treated as server-to-server traffic and still require the normal API authorization when the bucket is private.
