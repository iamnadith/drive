-- Adds optional linkage columns to bucket scan rows so scans can be audited per migration/item.
-- Safe to run multiple times.

alter table if exists public.drive_bucket_scans
  add column if not exists migration_id uuid references public.drive_migrations(id) on delete cascade;

alter table if exists public.drive_bucket_scans
  add column if not exists migration_item_id uuid references public.drive_migration_items(id) on delete cascade;

-- PostgREST caches the schema. If you just added columns, force a reload so the REST API sees them immediately.
notify pgrst, 'reload schema';

