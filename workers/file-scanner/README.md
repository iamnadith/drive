# File Scanner

An autonomous Cloudflare Worker for durable R2 inventory and migration verification. Each invocation processes one bounded R2 listing page, persists its opaque cursor and de-duplicated objects in PostgreSQL, then compares exact keys, sizes, and stable single-part ETags after both migration inventories finish. It also claims generic pending `drive_bucket_scans` rows for non-migration Drive inventory work.

Deploy with `PANEL_URL` and `FILE_SCANNER_SECRET` build variables. The deploy script fetches and injects only `POSTGRES_URL`; runtime URL, endpoint secret, and peer settings come from PostgreSQL. This Worker only inventories and verifies files. Migration lifecycle, account activation, bucket settings, and worker dispatch remain in the Migration Orchestrator.
