# Standalone Drive sync client: focused verification plan

Status: design only. This plan intentionally creates no Python client or production-code changes.

## Scope and test contract

The client accepts:

```text
panel_url   = https://drive.example.test
project_id  = the Drive project ID
bucket      = optional assigned bucket; otherwise use the project's primary bucket
api_key     = project API key secret
workers     = bounded per-file concurrency
part_workers = bounded per-part concurrency for multipart files
state_dir   = local crash-recovery state directory
```

Use the documented `/api/v1/files` upload surface as the canonical client contract. Every panel request must carry `Authorization: Bearer <api_key>` and JSON `projectId`/`bucket` values (the equivalent `X-Drive-*` headers are also accepted by the server). The API key must never be written to state, logs, exception text, or a signed-R2 request. The existing standalone client uses `POST /api/v1/files/uploads/presign`, which is an alias to the same single-upload start handler; test that alias separately if the client keeps using it.

### Endpoint matrix

| Operation | Request | Required permission | Success contract |
| --- | --- | --- | --- |
| Enumerate remote files | `GET /api/v1/files?projectId=...&bucket=...&prefix=...&limit=...&cursor=...` | `list` | JSON `{folders, objects[{key,size,etag,lastModified,fileId}], nextCursor, isTruncated}` |
| Start small/single upload | `POST /api/v1/files/upload` | `upload` | `{uploadType:"single", method:"PUT", url, key, bucketName, headers, expiresAt}` |
| Send single bytes | `PUT <signed url>` | none; signed URL only | R2 success is normally `200`, `201`, or `204`; capture any `ETag` if present |
| Finalize single upload | `PATCH /api/v1/files/upload` | `upload` | `200` with `size`, `etag`, `key`; or `202` with `pending:true` and `size:null` |
| Start multipart upload | `POST /api/v1/files/uploads/multipart` | `upload` | `{uploadType:"multipart", key, bucketName, uploadId}` |
| Get a part URL | `POST /api/v1/files/uploads/multipart/part` | `upload` | `{method:"PUT", url, key, uploadId, partNumber}` |
| Send a part | `PUT <signed part url>` | none; signed URL only | Capture the response `ETag` exactly |
| Complete multipart | `POST /api/v1/files/uploads/multipart/complete` | `upload` | `{ok:true, projectId, key, fileId}`; response does not include size |
| Abort multipart | `POST /api/v1/files/uploads/multipart/abort` | `upload` | `{ok:true, projectId, key}` |
| Verify exact size | `GET /api/v1/files/metadata?...` (`readMetadata`), `GET /api/v1/files` (`list`), or `HEAD /api/v1/storage/object/...` (`read`) | as shown | Compare remote size to local byte size; the `HEAD` contract exposes `Content-Length` and `X-Drive-Object-Size` |
| Preserve an empty directory | `POST /api/v1/files/folders` with `{projectId,bucket,key}` | `createFolder` | Folder marker key ends in `/` |

The client must not mix this flow with the separate `POST /api/v1/storage/multipart` action route. That route has different start/part/complete response shapes and normalizes ETags. If compatibility with it is later required, cover it with a separate adapter test suite.

## Mock server

Use a local `ThreadingHTTPServer` (or equivalent) with an in-memory object store and request recorder. Do not use real Drive, R2, credentials, or the database.

The fake server should implement the endpoint matrix above plus signed-URL `PUT` handlers. Each request record should include method, path, query, safe headers, body length, and parsed JSON, with the API key redacted before assertions.

The fixture needs:

- objects keyed by `(bucket, key)` with raw bytes, size, ETag, and committed state;
- multipart sessions keyed by `uploadId`, containing key, parts, and whether completion committed;
- a response/fault queue that can return valid JSON, malformed JSON, HTML, plain text, empty bodies, XML R2 errors, timeouts, connection resets, `429`, `5xx`, and `202`;
- barriers/events to pause a part upload and measure maximum concurrent uploads;
- crash hooks after every durable boundary so the test can terminate and restart the client.

Use a fake clock or zero-delay backoff in unit tests. Keep one small integration test with real bounded delays to prove deadline handling.

## Test checklist

### 1. Configuration, authentication, and manifest

- [ ] Trim a trailing slash from `panel_url`; append paths exactly once. Reject a missing/invalid panel URL, project ID, bucket value, API key, non-positive worker count, or unusable state directory before making HTTP calls.
- [ ] Send the API key as `Authorization: Bearer ...`; verify project and bucket are present in the panel JSON request. A project with no requested bucket uses the primary bucket; an explicitly requested bucket is retained.
- [ ] Verify that the API key is absent from signed single-upload and signed-part `PUT` requests. Signed URLs receive only the headers returned by the panel and the file bytes.
- [ ] Return useful errors for `401 Missing/Invalid API key`, `403 project/permission`, `404`, real `409 OBJECT_LOCKED`, `503 LOCK_CHECK_UNAVAILABLE`, and `429`; do not retry authorization, project, bucket, or lock failures blindly.
- [ ] A selected file uploads regardless of extension, MIME type, binary contents, or zero length. `contentType` is optional; when supplied, the exact value is used for the direct `PUT`.
- [ ] A selected folder recursively maps `relative/path` to POSIX-style remote keys below the configured prefix. Cover nested directories, Unicode, spaces, `#`, `%`, leading-dot names, extensionless files, duplicate basenames in different directories, and an empty directory.
- [ ] Define and test symlink/reparse-point policy. The default must not follow a link outside the selected root or recurse into a cycle.
- [ ] Produce a deterministic manifest and deduplicate identical `(bucket, remote_key)` entries before scheduling work.
- [ ] Detect a source file changing after manifest creation. Do not upload a partial/new version while claiming the old manifest entry succeeded; leave the source untouched and record a retryable failure.

### 2. JSON/error parsing and retry policy

- [ ] Parse a normal JSON error such as `{ "error": "Object is locked", "code": "OBJECT_LOCKED" }` and preserve HTTP status, endpoint, operation, and safe server message.
- [ ] Handle a `4xx` response with malformed JSON, HTML, plain text, and an empty body without raising a secondary JSON-decoding exception. The final error must contain the status and a bounded body preview.
- [ ] Handle a signed-R2 XML/HTML error in the same way; never require the direct R2 response to be JSON.
- [ ] On `429`, parse `Retry-After` and/or `retryAfterSeconds`, cap it, and retry only while the operation deadline remains. Test a missing, invalid, fractional, and excessive header.
- [ ] Retry network timeouts, connection resets, and `502/503/504` only for operations classified safe below. Use bounded exponential backoff with jitter, an attempt cap, and a total deadline; prove there is no infinite retry loop.
- [ ] Do not retry `400/401/403/404/409` automatically. A `409 OBJECT_LOCKED` is a user-visible conflict, not a transient upload failure. `503 LOCK_CHECK_UNAVAILABLE` from multipart start is safe to retry because the panel returns it before creating the R2 session; other ambiguous multipart-start `5xx` responses must remain protected by the unknown-start barrier. A signed-URL `403` may be retried only when it is explicitly classified as an expired/invalid signed URL and a fresh URL is requested; a panel authorization `403` is terminal.
- [ ] A retry must reuse the same logical key and, for multipart, the same `uploadId` and part number. It must never create a second destination key as a fallback.

Operation safety rules to assert explicitly:

- `PATCH` single finalize is safe to repeat with the same `{projectId,bucket,key}`.
- A direct `PUT` after an ambiguous response must verify the object first; if it is not an exact-size match, retry the same bytes to the same key.
- A multipart part `PUT` may repeat the same part number; a new part URL may be requested for the same `uploadId` if the old URL expired.
- Multipart `start` is not idempotent in the current API. If the connection fails after the server may have created a session, persist an `unknown_start` state and do not blindly start another session. This is a required test and an explicit API limitation.
- Multipart `complete` after an ambiguous response must verify the committed object before repeating the completion call. Never immediately create a new session.

### 3. Single-file flow and `202` finalize polling

- [ ] `POST /api/v1/files/upload` is JSON and returns the signed URL plus server-provided `Content-Type` when requested. Upload exact bytes, then `PATCH` the same project, bucket, and key.
- [ ] Include the per-file `drive-sync-fingerprint` metadata in the start request and send the corresponding `x-amz-meta-drive-sync-fingerprint` header on the signed single-file `PUT`. Finalize must return the same marker; missing or altered metadata with a matching size is a verification failure.
- [ ] On a `PATCH` sequence `202 pending:true` -> `202 pending:true` -> `200`, poll with bounded backoff and finish only on `200` with `size == local_size`. Assert that no second direct upload occurs during polling.
- [ ] Treat `202` as incomplete even when `ok:true`; do not mark the state complete, delete the source, or report success from a pending response.
- [ ] On a `202` timeout/deadline, retain `finalize_pending` state and resume with `PATCH` after restart. If the remote object is already exact-size, verification may finish the item without another upload.
- [ ] On `200`, compare `size` exactly, including `0`. Retain `etag`, `contentType`, metadata, and `lastModified` for diagnostics, but do not require a non-null `fileId`.
- [ ] Simulate a lost finalize response after the server has finalized. A retry or preflight verification must converge to one completed logical key.
- [ ] Simulate a direct `PUT` response lost after the mock committed bytes. Verify before resending; assert no duplicate key and exact final bytes.
- [ ] Simulate a remote size smaller or larger than the local size. Fail the item, keep the source and state, do not write a success marker, and do not count it in the completed summary.
- [ ] Upload an empty file through the single path and verify that an empty object is success, not a missing-object condition.

### 4. Multipart sessions and ETags

- [ ] Use a configurable threshold and part size. Test a file below the threshold, exactly at the threshold, and a file spanning at least three parts. Non-final parts must use the provider-valid multipart size.
- [ ] Persist the returned `uploadId` immediately after start, before uploading part 1. Persist each part's number, byte offset, length, and ETag before scheduling the next part.
- [ ] Request one part URL per part and `PUT` the exact byte slice. Assert `partNumber` is 1-based, no part is skipped, no two workers own the same part, and no Drive API key is sent to R2.
- [ ] Return ETags as quoted values, bare values, and weak values from the mock. For the canonical `/api/v1/files/uploads/multipart/complete` route, send the exact response header value back in the `parts` array; do not compute an MD5 or assume a composite ETag. Add a separate adapter assertion if the alternate `/api/v1/storage/multipart` route is supported.
- [ ] Complete with all parts, sorted ascending by `partNumber`, and assert the payload contains no duplicate/missing parts. The mock must reject an altered ETag.
- [ ] Fail one part with `500`, timeout, and connection reset. Retry the same `uploadId` and part number, then complete once with the newly observed ETag.
- [ ] Make a part response disappear after the mock stores the part. Retrying the same part number must converge without creating a new session.
- [ ] Return an expired signed part URL. Request a fresh part URL using the same `uploadId` and part number; do not restart multipart.
- [ ] Make complete commit the object and then drop the response. On restart, exact-size verification must mark it complete without a second start. If verification cannot find it, retry complete with the same `uploadId` and parts before considering a new session.
- [ ] Return explicit `NoSuchUpload`/invalid-upload errors. If the object is absent, mark the session stale, retain evidence, abort when possible, and only then allow a new session under a documented recovery policy.
- [ ] On unrecoverable failure, attempt abort. If abort itself fails, retain the session in state and report cleanup pending; never claim cleanup succeeded.
- [ ] After multipart completion, call `PATCH /api/v1/files/upload` (or its `POST /api/v1/storage/finalize` alias) to obtain the same `202`/`200` size-and-metadata verification used by single uploads. `readMetadata`, `list`, or authenticated object `HEAD` are valid alternatives when their permissions are available. The multipart complete response itself has no size.

### 5. Durable state and crash recovery

The per-file state should contain only non-secret data, for example:

```json
{
  "version": 1,
  "config": {"panelUrl": "...", "projectId": "...", "bucket": "..."},
  "source": {"path": "...", "size": 123, "mtimeNs": 456},
  "key": "folder/file.bin",
  "mode": "single",
  "phase": "finalize_pending",
  "uploadId": null,
  "parts": {}
}
```

- [ ] Write state atomically to a temporary file, flush it, replace the prior state, and recover the last complete record after a forced process termination during a write.
- [ ] Inject a crash before start response, after start response, after each part `PUT`, after ETag capture but before state flush, after multipart complete, after direct `PUT`, and after every `202` finalize poll.
- [ ] Restart from each checkpoint. Reuse a known `uploadId`; re-send at most the uncertain part; never upload a completed file from scratch merely because the previous response was lost.
- [ ] If state says complete but remote verification is missing or the size differs, repair/reconcile instead of trusting stale state. Keep the source file.
- [ ] If the source size/mtime fingerprint changed, refuse to resume old bytes. Mark the old state stale and require a fresh upload decision.
- [ ] Handle missing, truncated, invalid-version, and hand-edited state files without crashing the whole queue. Do not silently turn an ambiguous session into a new duplicate session.
- [ ] State/log paths must not contain the API key. Redacted error serialization must remain safe even when a server echoes request data.

### 6. Duplicate-process locking and multiple workers

- [ ] Acquire an OS-level exclusive lock for the logical job `(panel_url, project_id, bucket, selected_root, remote_prefix)`, using a hashed lock filename so secrets never appear in the path.
- [ ] Start two real processes with the same job. Exactly one acquires the lock; the other exits clearly before making any panel or signed-R2 request.
- [ ] Kill the lock owner and start a replacement. The OS handle, not a stale PID timestamp, determines lock ownership; the replacement may acquire the lock after the process exits.
- [ ] Permit different jobs to run concurrently when their lock keys differ, while preventing two jobs from claiming the same `(bucket,key)` through manifest deduplication and per-file state.
- [ ] With `workers=4`, block four mock part/file uploads and assert maximum active uploads is `4`, never `5`. With `workers=1`, assert strict serial behavior.
- [ ] Ensure a worker exception does not lose other queued files. Each file ends in exactly one durable state: completed, skipped-after-verification, pending, or failed.
- [ ] Assert the executor is created and started once per process. A repeated `run()`/start call must not spawn duplicate worker pools or submit the same manifest twice.
- [ ] Stop/cancel the queue and wait for in-flight futures to finish or reach a durable canceled state before reporting that workers stopped.
- [ ] Run two processes against the same folder with a server barrier. The final object inventory must contain one logical key per source file, no duplicate multipart sessions for recovered files, and exact sizes for every completed object.

### 7. Folder-complete acceptance

- [ ] After a successful folder run, page through the remote prefix until `nextCursor` is null (or use the paged storage-list adapter) and compare the expected key set and exact sizes.
- [ ] Preserve empty directories with `/api/v1/files/folders` when the configured key has `createFolder`; otherwise report the documented limitation rather than claiming byte-for-byte folder equivalence.
- [ ] A pre-existing remote key with the same size is skipped only after verification. A different-size object follows the configured conflict policy and is verified after replacement.
- [ ] Default mode is upload/sync-only: never delete local source files or unrelated remote objects. Any future mirror/delete mode needs a separate explicit contract and destructive tests.
- [ ] A final summary counts only exact-size verified objects. Pending `202`, failed, locked, ambiguous-start, stale-session, and size-mismatch items remain visible and machine-readable.

## Suggested test names

```text
test_config_normalizes_panel_url_and_redacts_api_key
test_json_and_non_json_errors_are_safe
test_retry_after_and_transient_retry_deadline
test_single_upload_preserves_binary_and_zero_byte_files
test_finalize_202_is_polled_without_reupload
test_finalize_size_mismatch_never_marks_complete
test_multipart_persists_upload_id_and_sends_exact_etags
test_multipart_reuses_session_after_part_timeout
test_multipart_lost_complete_response_reconciles_before_retry
test_state_recovers_after_each_crash_boundary
test_same_job_second_process_is_locked_before_http
test_worker_count_is_bounded_and_manifest_is_deduplicated
test_folder_inventory_matches_remote_keys_and_sizes
```

## Contract gaps to keep visible

1. The current single-upload finalize implementation returns `fileId: null`, despite the dashboard example showing a permanent ID. Sync completion must be based on the verified key and size, not on `fileId`.
2. The current multipart complete response does not include remote size or ETag. Exact-size and fingerprint verification therefore needs the finalize request (which uses `upload` permission) or `list`, `readMetadata`, or `read` permission after completion.
3. Multipart start has no idempotency key or session-status endpoint. A transport failure after session creation cannot be proven safe to repeat; the client must preserve `unknown_start` and avoid a blind second start. The explicit `LOCK_CHECK_UNAVAILABLE` response is the narrow exception because it is emitted before session creation.
4. `/api/v1/files/uploads/multipart/...` and `/api/v1/storage/multipart` are not interchangeable contracts. Keep their payload and ETag rules isolated in tests.
5. Exact size does not prove byte identity by itself. The current API has no portable checksum field; the sync fingerprint metadata must round-trip for this client, and a stronger cross-client byte-integrity requirement needs a checksum contract and its own test.

## Exit criteria

The client is ready for a controlled live-bucket smoke test only when every checklist item above has a passing mock-server test, crash/restart tests leave the source files intact, no test logs a secret, concurrency never exceeds the configured worker count, and every reported success has exact remote-size evidence.
