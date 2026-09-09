# File Scanner

An autonomous Cloudflare Worker for durable R2 inventory and migration verification. Each invocation processes one bounded R2 listing page, persists its opaque cursor and de-duplicated objects in PostgreSQL, then immediately queues the next page instead of waiting for the next cron minute. The Migration Orchestrator converts the committed source inventory into disjoint worker batches. After migration, File Scanner independently compares exact keys, sizes, and stable single-part ETags before completion.

Deploy with `PANEL_URL` and `FILE_SCANNER_SECRET` build variables. The deploy script verifies Wrangler authentication, creates the continuation queue and dead-letter queue when missing, and injects the database configuration. This Worker only inventories and verifies files. Migration lifecycle, account activation, bucket settings, and worker dispatch remain in the Migration Orchestrator.
