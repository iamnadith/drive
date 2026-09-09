# File Scanner

An autonomous Cloudflare Worker for durable R2 inventory and migration verification. Each invocation processes at most 100 R2 objects, persists its opaque cursor and de-duplicated objects in PostgreSQL, then immediately queues the next scan page. Only after the complete source inventory is committed does the Migration Orchestrator materialize one-file jobs and start migration workers. After migration, File Scanner independently scans the destination, compares the completed inventory, and requires the per-file SHA-256/ETag proof before completion.

Deploy with `PANEL_URL` and `FILE_SCANNER_SECRET` build variables. The deploy script verifies Wrangler authentication, creates the continuation queue and dead-letter queue when missing, and injects the database configuration. This Worker only inventories and verifies files. Migration lifecycle, account activation, bucket settings, and worker dispatch remain in the Migration Orchestrator.
