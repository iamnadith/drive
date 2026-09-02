# Standalone Drive Sync

`tools/drive-sync/drive_sync.py` is a standalone Python client for uploading selected files or a selected folder tree to a Drive project bucket. It sends file bytes directly to short-lived R2 signed URLs created by the panel; the panel owns the R2 credentials.

The client is a single command, not a subcommand-based CLI. Running the same command again with the same selection and state file is the current resume operation.

## Native Windows GUI

For a low-memory desktop workflow, use the native .NET WinForms wrapper in [`gui/`](gui/). It keeps this Python engine unchanged, lets you choose a folder or individual files, loads an existing resume JSON, and passes the API key to the child process through its environment instead of the command line. Run it from the repository root with:

```powershell
dotnet run --project tools/drive-sync/gui/DriveSync.Gui.csproj
```

The GUI supports the same bounded file and multipart worker settings. Its publish instructions are in [`gui/README.md`](gui/README.md).

## Configuration

Values are resolved in this order: explicit command-line option, JSON config, environment variable, then an interactive prompt. `--non-interactive` disables prompts and fails when a value is missing.

| Value | CLI option | Config key | Environment variable | Required by client |
| --- | --- | --- | --- | --- |
| Panel URL | `--panel-url` | `panel_url` or `drive_url` | `DRIVE_PANEL_URL` or `DRIVE_URL` | Yes |
| Project ID | `--project-id` | `project_id` | `DRIVE_PROJECT_ID` | Yes |
| Bucket | `--bucket` | `bucket` or `bucket_name` | `DRIVE_BUCKET` | Yes |
| API key | `--api-key` | `api_key` or `drive_api_key` | `DRIVE_API_KEY` | Yes |
| State path | `--state-file` | not used | not used | No |

The panel URL must be an absolute `http://` or `https://` URL without a query or fragment. The client removes a trailing slash and a trailing `/api/v1` if supplied, then appends `/api/v1` itself.

The current client asks for a bucket even though the panel API can resolve a project's primary bucket when the bucket is omitted. Supplying the bucket is recommended because it makes the resume identity and target unambiguous. An explicitly selected bucket must be assigned to the project and available in the panel's active Cloudflare account.

The API key can be entered with a hidden prompt or supplied through `DRIVE_API_KEY`. `--api-key` and a JSON config key are supported, but they can leak through shell history, process listings, backups, or file permissions. Prefer an environment/secret-manager injection or the hidden prompt. The key must never be placed in a URL, written to resume state, sent to an R2 signed URL, or printed in logs.

The client sends the panel key as:

```http
Authorization: Bearer <drive-api-key>
X-Drive-Project: <project-id>
X-Drive-Bucket: <bucket-name>
```

The panel also accepts `X-Drive-API-Key`. Project API keys are assigned per project and may be disabled or expired. The current upload path needs `upload`; preserving empty folders additionally needs `createFolder`. A future remote-list or authenticated-`HEAD` preflight needs `list` and/or `read` respectively. The panel's **Read + write** preset includes the upload and folder capabilities, but a narrower custom key is possible.

### JSON configuration

`--config` accepts a JSON object. Do not commit a file containing a live secret.

```json
{
  "panel_url": "https://drive.example.com",
  "project_id": "project-id-from-drive",
  "bucket": "assigned-bucket",
  "api_key": "load-this-file-securely"
}
```

## Usage and selection

Upload a folder recursively:

```powershell
python tools/drive-sync/drive_sync.py --panel-url https://drive.example.com --project-id PROJECT_ID --bucket BUCKET --folder "C:\Data\ToUpload" --workers 3 --part-workers 4
```

Upload selected individual files by repeating `--file`:

```powershell
python tools/drive-sync/drive_sync.py --panel-url https://drive.example.com --project-id PROJECT_ID --bucket BUCKET --file "C:\Data\a.bin" --file "C:\Data\b.mp4"
```

`--folder` and `--file` are mutually exclusive. In interactive mode, omitting both opens the Windows picker, which can choose either one folder or multiple files; `--select` is the explicit picker option exposed by the CLI. With `--non-interactive`, provide `--folder` or at least one `--file`.

Folder keys include the selected folder name by default. Use `--contents-only` to put its contents directly below `--prefix`. File keys use `/` separators, preserve nested paths and Unicode names, and reject unsafe `.` or `..` components. Symlinked directories are not followed. Duplicate selections that map to one key are rejected.

All regular files are supported, including extensionless, binary, Unicode-named, and zero-byte files. MIME detection only supplies `Content-Type`; unknown types use `application/octet-stream`. The source is rechecked while uploading so a changing file is not marked complete.

Empty folders are preserved by default with zero-byte trailing-slash folder markers. Disable this with `--no-preserve-empty-folders`. Folder markers use `POST /api/v1/files/folders` and require `createFolder`.

`--dry-run` scans and prints the selection and state path without making upload requests. The base command is upload/sync-only: it never deletes remote objects that are absent from the local selection.

## State, resume, and locking

The default state path is `%LOCALAPPDATA%\DriveSync\state\<target-hash>.json`. Set an explicit path with `--state-file`. The client creates a sibling `<state-file>.lock` and takes an OS-level exclusive lock, so a second process using the same state cannot start duplicate work. Different target identities should use different state files.

State is versioned and bound to the normalized panel URL, project ID, bucket, prefix, source paths, folder-root policy, and empty-folder policy. It contains per-file source path, size, modification time, key, upload type, status, part layout, upload ID, part sizes, ETags, metadata marker, and last error. It does not contain the API key.

State writes use a temporary file, `fsync`, and atomic replacement. The state is saved after discovery, stage transitions, every completed multipart part, and final verification. A normal interruption leaves the source and resumable state in place; rerun the same command to continue.

The current source fingerprint is a SHA-256 marker over the target, object key, source size, and source modification time. It is not a full content digest. The client compares size and modification time before and after transfer and can restart a changing source a bounded number of times, but equal-size/equal-time content changes cannot be ruled out by this marker alone.

For a known multipart upload, resume reuses the saved `uploadId` and re-uploads only missing or uncertain parts with the same part number. If multipart start may have succeeded but its response was lost, the client records `ambiguous_multipart_start` and deliberately does not start a second session. Use `--reset-ambiguous` only after checking or retiring the possible orphan upload. A generic completion or network error is reconciled through finalization before a new session is considered.

On a later run, a state record marked `complete` is checked again through
`PATCH /files/upload` before it is counted as skipped. A missing, replaced, or
wrong-size object is repaired at the same logical key. The API routes for
listing and authenticated `HEAD` are documented below for broader operator
reconciliation.

## Concurrency and retries

`--workers` controls concurrent file tasks. The default is `3`, and the client caps it at `16`. Multipart files create a per-file part pool controlled by `--part-workers`, default `4` and capped at `16`. Because the part pool is per active file, total part requests can approach `workers * part-workers`; keep both values bounded for the panel, R2, and local disk.

The defaults are:

| Option | Default | Constraint or meaning |
| --- | ---: | --- |
| `--workers` | `3` | File-level workers, maximum `16`. |
| `--part-workers` | `4` | Part workers per multipart file, maximum `16`. |
| `--single-threshold-mb` | `64` | Files at or above this size use multipart. |
| `--part-size-mb` | `64` | Multipart part size; minimum `5` MiB, maximum `5` GiB. |
| `--retries` | `5` | Bounded retry attempts for eligible operations. |
| `--timeout` | `120` seconds | Per-request socket timeout. |
| `--finalize-timeout` | `60` seconds | Visibility/finalization polling window. |

Multipart parts are 1-based, at most `10,000`, and use the configured part size except for the final part. The current implementation uses thread pools and streams file sections instead of loading a whole file into memory.

Transient transport failures and `408`, `425`, `429`, `500`, `502`, `503`, and `504` are eligible for bounded retry. `Retry-After` is honored when present; otherwise the backoff is capped at 30 seconds. Authorization, project, bucket, and lock errors must remain visible instead of being retried indefinitely. A signed-URL `403` is handled as a possible expired URL by the upload operation, but a panel authorization `403` is not silently retried.

Progress output is rate-limited/replaced, and `--quiet` reduces it. The final summary reports uploaded, skipped, failed, and empty-folder counts. A nonzero exit code is used when file or empty-folder failures remain.

## Current panel route contract

All routes below are relative to `{panel-url}/api/v1`. Panel requests carry the API key and project/bucket context. The signed R2 requests do not.

### Direct/single upload

The client uses this sequence for files below `--single-threshold-mb`, including zero-byte files:

1. `POST /files/uploads/presign` with JSON containing `projectId`, `bucket`, `key`, `contentType`, `expiresInSeconds`, and the client metadata marker `drive-sync-fingerprint`.
2. `PUT` the raw file bytes to the returned signed `url`, using the returned headers plus `Content-Length`, `Content-Type`, and `x-amz-meta-drive-sync-fingerprint`. Only the bytes and signed-upload headers go to R2.
3. `PATCH /files/upload` with `{projectId,bucket,key}`. The current finalizer polls/retries while the object is pending, then checks exact `size` and the fingerprint metadata. A successful direct response can have `fileId: null`; the client does not require a file ID.

`POST /files/upload` is a compatible panel start route, but the current client uses `/files/uploads/presign`. A `202` response with `pending: true` is not success; repeat finalization for the same key and do not start another direct object. The lower-level `PUT /storage/object/{key}` route proxies bytes through the panel and is not the intended path for large standalone transfers.

### Multipart upload

For files at or above the threshold, the current client uses the dedicated route family:

```text
POST /files/uploads/multipart
POST /files/uploads/multipart/part
POST /files/uploads/multipart/complete
POST /files/uploads/multipart/abort
```

The sequence is:

1. Start with `projectId`, `bucket`, `key`, `contentType`, and the fingerprint metadata. Save `uploadId` before requesting part 1.
2. For every missing part, request a signed URL with `uploadId` and `partNumber`, then `PUT` the exact byte range directly to R2. Save the response ETag exactly with its part number and byte length.
3. Complete with the same target, `uploadId`, and all `{partNumber,etag}` entries in ascending order. The client then finalizes and verifies the committed object because multipart completion itself does not return a remote size.
4. Abort only an explicitly retired/invalid session. An abort discards uncommitted parts and is not used as a generic response-loss workaround.

The repository also exposes `POST /storage/multipart` with `action: start | part | complete | abort`. It is an alternate action-based contract. Do not mix its payload or ETag behavior with the dedicated `/files/uploads/multipart/*` session used by this client.

### Inventory and exact verification routes

The panel provides these routes for a future or operator-driven remote reconciliation pass:

- `GET /files?projectId=...&bucket=...&prefix=...&limit=...&cursor=...` returns paged `objects` with `key`, `size`, `etag`, `lastModified`, and possibly `fileId`, plus `nextCursor` and `isTruncated`.
- `GET /storage/list?paged=1&projectId=...&bucket=...&prefix=...` uses `continuationToken` and `nextContinuationToken`.
- `HEAD /storage/object/{encoded-key}?projectId=...&bucket=...` returns `Content-Length`, and when available `ETag` and `Content-Type`.
- `GET /files/metadata?projectId=...&bucket=...&key=...` returns metadata and size when the key has `readMetadata` permission.

The current script verifies an active upload through `PATCH /files/upload` and its fingerprint metadata rather than performing a pre-upload list or `HEAD`. A stronger no-overwrite or stale-state policy should add one of these read-capable checks and use the panel's conditional presign fields (`ifNoneMatch` or `ifMatch`); the current CLI does not expose those fields.

## Locks and safe behavior

The panel can protect an object with `/files/locks`, and write routes respond with `409 Object is locked` plus `code: OBJECT_LOCKED` when an active lock is found. The response may include the lock `reason`, `createdAt`, and `expiresAt`, but never the lock token. Use `GET /files/locks?projectId=...&bucket=...&key=...` with a read-capable API key to inspect one key without changing it. The current client does not acquire, clear, or override server-side locks and does not expose a lock-token option. A locked item remains failed in local state for operator resolution; it is not blindly retried.

If the panel cannot query its lock store, it returns `503 LOCK_CHECK_UNAVAILABLE` instead of incorrectly reporting a lock. This is safe to rerun because the multipart session has not been created when that response is returned.

The client is safe by default in these ways:

- It never deletes, renames, truncates, or moves local source files.
- It never deletes remote objects that are outside the selected files/folder.
- It uses deterministic keys and one state record per key, so retries target the same object rather than creating alternate names.
- It preserves state and multipart sessions across Ctrl-C or process failure.
- It records exact remote size and the sync fingerprint before marking an item complete.
- It redacts signed URLs in errors and keeps API keys out of state and ordinary logs.

The current client does not perform a remote conflict preflight and does not send `ifNoneMatch`/`ifMatch` on its presign request. A fresh upload to an already existing same key can therefore replace that key. Treat overwrite prevention as a required follow-up if the bucket contains data that must never be replaced.

The route source of truth is `src/lib/project-api-auth.ts`, `src/lib/project-upload-api.ts`, and the routes under `src/app/api/v1/files/uploads/`, `src/app/api/v1/files/`, and `src/app/api/v1/storage/`.
