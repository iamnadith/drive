-- Store "directory marker" placeholder objects without counting them as real files.
-- Safe to run multiple times.

alter table if exists public.drive_bucket_scan_objects
  add column if not exists is_dir_marker boolean not null default false;

notify pgrst, 'reload schema';

