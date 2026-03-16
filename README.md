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
