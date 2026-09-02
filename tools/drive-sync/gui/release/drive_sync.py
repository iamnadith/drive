#!/usr/bin/env python3
"""Crash-safe local-to-Drive file and folder synchronizer.

The panel owns the R2 credentials.  This client only needs a panel URL, a
project ID, a bucket assigned to that project, and a project API key with the
upload/createFolder permissions.  File bytes go directly from this process to
the short-lived R2 URL returned by the panel; the API key is never sent to R2
and is never written to the resume state.

The script intentionally does not delete remote objects that are absent from
the local selection.  A local selection is therefore safe to resume and to
run again without turning a scan mistake into remote deletion.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import getpass
import hashlib
import json
import mimetypes
import os
import socket
import stat
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


STATE_VERSION = 1
DEFAULT_SINGLE_THRESHOLD = 64 * 1024 * 1024
DEFAULT_PART_SIZE = 64 * 1024 * 1024
MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024
MAX_MULTIPART_PART_SIZE = 5 * 1024 * 1024 * 1024
MAX_MULTIPART_PARTS = 10_000
MAX_FILE_WORKERS = 16
MAX_PART_WORKERS = 16
MAX_SOURCE_RESTARTS = 2
RETRYABLE_HTTP_STATUSES = {408, 425, 429, 500, 502, 503, 504}
METADATA_NAME = "drive-sync-fingerprint"


class SyncError(Exception):
    """An expected, user-actionable synchronizer error."""


class ProtocolError(SyncError):
    pass


class VerificationError(SyncError):
    pass


class PendingVerification(SyncError):
    pass


class AmbiguousRequestError(SyncError):
    """A request may have reached the server but its response was lost."""


class AmbiguousMultipartStart(AmbiguousRequestError):
    pass


def panel_error_code(body: str) -> str | None:
    try:
        decoded = json.loads(body)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    code = decoded.get("code")
    return code.strip() if isinstance(code, str) and code.strip() else None


class DriveHttpError(SyncError):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        body: str = "",
        retry_after: float | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.retry_after = retry_after
        self.api_code = panel_error_code(body)
        detail = f"HTTP {status}: {message}"
        if body:
            compact = " ".join(body.split())
            if compact:
                detail += f" ({compact[:500]})"
        super().__init__(detail)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def format_bytes(value: int | float) -> str:
    amount = float(max(0, value))
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    unit = units[0]
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            break
        amount /= 1024
    if unit == "B":
        return f"{int(amount)} {unit}"
    return f"{amount:.1f} {unit}"


def parse_positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError(f"{name} must be greater than zero")
    return parsed


def normalize_panel_url(value: str) -> str:
    panel = value.strip().rstrip("/")
    if panel.lower().endswith("/api/v1"):
        panel = panel[:-len("/api/v1")].rstrip("/")
    parsed = urlsplit(panel)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SyncError("Panel URL must be an absolute http:// or https:// URL")
    if parsed.query or parsed.fragment:
        raise SyncError("Panel URL must not contain a query string or fragment")
    return panel


def normalize_key_part(value: str, *, allow_empty: bool = True) -> str:
    normalized = value.replace("\\", "/").strip("/")
    if not normalized and allow_empty:
        return ""
    if not normalized:
        raise SyncError("Object key cannot be empty")
    if any(part in {".", ".."} for part in normalized.split("/")):
        raise SyncError(f"Unsafe object key component: {value!r}")
    return normalized


def join_key(*parts: str, trailing_slash: bool = False) -> str:
    cleaned = [normalize_key_part(part) for part in parts]
    key = "/".join(part for part in cleaned if part)
    if not key:
        if trailing_slash:
            raise SyncError("Cannot create a root-level empty folder key")
        raise SyncError("Object key cannot be empty")
    return f"{key}/" if trailing_slash else key


def source_fingerprint(project_id: str, bucket: str, key: str, size: int, mtime_ns: int) -> str:
    material = f"{project_id}\0{bucket}\0{key}\0{size}\0{mtime_ns}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def content_type_for(path: Path) -> str:
    guessed, _encoding = mimetypes.guess_type(path.name, strict=False)
    return guessed or "application/octet-stream"


def snapshot_file(path: Path, key: str) -> "FileSnapshot":
    try:
        info = path.stat()
    except OSError as exc:
        raise SyncError(f"Unable to inspect {path}: {exc}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise SyncError(f"Not a regular file: {path}")
    return FileSnapshot(
        path=path,
        key=key,
        size=int(info.st_size),
        mtime_ns=int(info.st_mtime_ns),
    )


def snapshot_matches(path: Path, snapshot: "FileSnapshot") -> bool:
    try:
        info = path.stat()
    except OSError:
        return False
    return (
        stat.S_ISREG(info.st_mode)
        and int(info.st_size) == snapshot.size
        and int(info.st_mtime_ns) == snapshot.mtime_ns
    )


def redact_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        pass
    return "<remote-url>"


def safe_exception_text(error: BaseException) -> str:
    if isinstance(error, DriveHttpError):
        return str(error)
    if isinstance(error, AmbiguousRequestError):
        return str(error)
    text = str(error).strip()
    return f"{type(error).__name__}: {text[:500]}" if text else type(error).__name__


def retry_after_seconds(headers: Any) -> float | None:
    raw = headers.get("Retry-After") if headers is not None else None
    if not raw:
        return None
    try:
        return max(0.0, min(300.0, float(raw)))
    except (TypeError, ValueError):
        pass
    try:
        date = parsedate_to_datetime(str(raw))
        if date.tzinfo is None:
            date = date.replace(tzinfo=dt.timezone.utc)
        return max(0.0, min(300.0, date.timestamp() - time.time()))
    except (TypeError, ValueError, OverflowError):
        return None


def backoff_seconds(attempt: int, server_delay: float | None = None) -> float:
    if server_delay is not None:
        return min(300.0, max(0.0, server_delay))
    # A small random component is unnecessary here because the process lock
    # already serializes duplicate clients for one state file.
    return min(30.0, 0.75 * (2**attempt))


@dataclass(frozen=True)
class FileSnapshot:
    path: Path
    key: str
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class FolderSnapshot:
    path: Path
    key: str


@dataclass(frozen=True)
class ScanResult:
    files: tuple[FileSnapshot, ...]
    empty_folders: tuple[FolderSnapshot, ...]
    errors: tuple[str, ...]


class ProgressReporter:
    def __init__(self, snapshots: Sequence[FileSnapshot], quiet: bool = False) -> None:
        self._sizes = {item.key: item.size for item in snapshots}
        self._current: dict[str, int] = {}
        self._completed_keys: set[str] = set()
        self._completed_bytes = 0
        self._total_bytes = sum(item.size for item in snapshots)
        self._quiet = quiet
        self._last_render = 0.0
        self._lock = threading.Lock()

    def seed(self, records: Iterable[dict[str, Any]]) -> None:
        with self._lock:
            for record in records:
                key = str(record.get("key", ""))
                if key not in self._sizes:
                    continue
                if record.get("status") == "complete":
                    self._completed_keys.add(key)
                    self._completed_bytes += self._sizes[key]
                    continue
                part_bytes = 0
                parts = record.get("parts")
                if isinstance(parts, dict):
                    for item in parts.values():
                        if isinstance(item, dict):
                            try:
                                part_bytes += max(0, int(item.get("size", 0)))
                            except (TypeError, ValueError):
                                continue
                self._current[key] = min(self._sizes[key], part_bytes)

    def add(self, key: str, amount: int) -> None:
        if amount <= 0:
            return
        with self._lock:
            maximum = self._sizes.get(key, 0)
            self._current[key] = min(maximum, self._current.get(key, 0) + amount)
            self._render_locked()

    def mark_complete(self, key: str) -> None:
        with self._lock:
            if key not in self._completed_keys:
                self._completed_keys.add(key)
                self._completed_bytes += self._sizes.get(key, 0)
            self._current.pop(key, None)
            self._render_locked(force=True)

    def mark_skipped(self, key: str) -> None:
        with self._lock:
            if key not in self._completed_keys:
                self._completed_keys.add(key)
                self._completed_bytes += self._sizes.get(key, 0)
            self._current.pop(key, None)
            self._render_locked(force=True)

    def finish(self) -> None:
        with self._lock:
            if not self._quiet:
                sys.stdout.write("\n")
                sys.stdout.flush()

    def _render_locked(self, *, force: bool = False) -> None:
        if self._quiet:
            return
        now = time.monotonic()
        if not force and now - self._last_render < 0.2:
            return
        self._last_render = now
        in_flight = sum(self._current.values())
        total = self._total_bytes
        moved = min(total, self._completed_bytes + in_flight)
        percent = 100.0 if total == 0 else (moved / total) * 100.0
        line = f"\rSync {percent:6.2f}%  {format_bytes(moved)} / {format_bytes(total)}"
        sys.stdout.write(line.ljust(80))
        sys.stdout.flush()


class ProcessFileLock:
    """Cross-platform advisory lock that the OS releases after a crash."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle: Any = None

    def __enter__(self) -> "ProcessFileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = open(self.path, "a+b")
        self._handle.seek(0, os.SEEK_END)
        if self._handle.tell() == 0:
            self._handle.write(b"0")
            self._handle.flush()
        self._handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError) as exc:
            self._handle.close()
            self._handle = None
            raise SyncError(
                f"Another sync process already owns the state lock: {self.path}"
            ) from exc
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        if self._handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self._handle.seek(0)
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None


class StateStore:
    def __init__(self, path: Path, identity: dict[str, Any]) -> None:
        self.path = path
        self._lock = threading.RLock()
        self.data: dict[str, Any] = {
            "version": STATE_VERSION,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "identity": identity,
            "files": {},
            "folders": {},
        }

    @classmethod
    def load(cls, path: Path, identity: dict[str, Any]) -> "StateStore":
        store = cls(path, identity)
        if not path.exists():
            store.save()
            return store
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SyncError(
                f"Resume state is unreadable; preserve it and fix or choose another --state-file: {path}"
            ) from exc
        if not isinstance(loaded, dict) or loaded.get("version") != STATE_VERSION:
            raise SyncError(f"Unsupported resume state version in {path}")
        if loaded.get("identity") != identity:
            raise SyncError(
                "The selected sources/configuration do not match the existing resume state. "
                f"Use the original selection or choose another --state-file: {path}"
            )
        loaded.setdefault("files", {})
        loaded.setdefault("folders", {})
        if not isinstance(loaded["files"], dict) or not isinstance(loaded["folders"], dict):
            raise SyncError(f"Resume state has invalid file/folder maps: {path}")
        store.data = loaded
        return store

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data["updatedAt"] = utc_now()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(self.data, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            for attempt in range(5):
                try:
                    os.replace(temporary, self.path)
                    temporary = None
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.2)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    def get_file(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self.data["files"].get(key)
            return copy.deepcopy(value) if isinstance(value, dict) else None

    def get_folder(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self.data["folders"].get(key)
            return copy.deepcopy(value) if isinstance(value, dict) else None

    def all_file_records(self) -> list[dict[str, Any]]:
        with self._lock:
            return [copy.deepcopy(item) for item in self.data["files"].values() if isinstance(item, dict)]

    def replace_file(
        self,
        snapshot: FileSnapshot,
        content_type: str,
        part_size: int,
        marker: str,
        upload_type: str,
    ) -> None:
        with self._lock:
            self.data["files"][snapshot.key] = {
                "key": snapshot.key,
                "sourcePath": str(snapshot.path),
                "size": snapshot.size,
                "mtimeNs": snapshot.mtime_ns,
                "contentType": content_type,
                "marker": marker,
                "status": "pending",
                "uploadType": upload_type,
                "partSize": part_size,
                "uploadId": None,
                "parts": {},
                "attempts": 0,
                "lastError": None,
                "updatedAt": utc_now(),
            }
            self._save_locked()

    def ensure_file_fields(
        self,
        key: str,
        *,
        content_type: str,
        part_size: int,
        marker: str,
    ) -> None:
        with self._lock:
            record = self.data["files"].get(key)
            if not isinstance(record, dict):
                return
            record.setdefault("contentType", content_type)
            record.setdefault("partSize", part_size)
            record.setdefault("parts", {})
            record.setdefault("attempts", 0)
            record["marker"] = marker
            self._save_locked()

    def update_file(self, key: str, **changes: Any) -> None:
        with self._lock:
            record = self.data["files"].get(key)
            if not isinstance(record, dict):
                raise SyncError(f"Missing state record for {key}")
            record.update(changes)
            record["updatedAt"] = utc_now()
            self._save_locked()

    def mark_part_uploaded(self, key: str, part_number: int, size: int, etag: str) -> None:
        with self._lock:
            record = self.data["files"].get(key)
            if not isinstance(record, dict):
                raise SyncError(f"Missing state record for {key}")
            parts = record.setdefault("parts", {})
            parts[str(part_number)] = {"size": size, "etag": etag}
            record["status"] = "multipart_uploading"
            record["lastError"] = None
            record["updatedAt"] = utc_now()
            self._save_locked()

    def replace_folder(self, folder: FolderSnapshot) -> None:
        with self._lock:
            self.data["folders"][folder.key] = {
                "key": folder.key,
                "sourcePath": str(folder.path),
                "status": "pending",
                "updatedAt": utc_now(),
            }
            self._save_locked()

    def update_folder(self, key: str, **changes: Any) -> None:
        with self._lock:
            record = self.data["folders"].get(key)
            if not isinstance(record, dict):
                raise SyncError(f"Missing folder state record for {key}")
            record.update(changes)
            record["updatedAt"] = utc_now()
            self._save_locked()


class FileSection:
    def __init__(self, path: Path, offset: int, length: int, on_bytes: Callable[[int], None] | None) -> None:
        self._handle = open(path, "rb")
        self._handle.seek(offset)
        self._remaining = length
        self._on_bytes = on_bytes

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        requested = self._remaining if size is None or size <= 0 else min(size, self._remaining)
        requested = min(requested, 1024 * 1024)
        data = self._handle.read(requested)
        if not data:
            raise SyncError("Source file ended before the expected upload range")
        self._remaining -= len(data)
        if self._on_bytes is not None:
            self._on_bytes(len(data))
        return data

    def close(self) -> None:
        self._handle.close()


class DriveClient:
    def __init__(
        self,
        panel_url: str,
        project_id: str,
        bucket: str,
        api_key: str,
        *,
        timeout: float,
        retries: int,
    ) -> None:
        self.panel_url = normalize_panel_url(panel_url)
        self.project_id = project_id.strip()
        self.bucket = bucket.strip()
        self.api_key = api_key.strip()
        if self.api_key.lower().startswith("bearer "):
            self.api_key = self.api_key[7:].strip()
        if not self.project_id or not self.bucket or not self.api_key:
            raise SyncError("Project ID, bucket, and Drive API key are required")
        self.timeout = timeout
        self.retries = retries
        self.api_root = f"{self.panel_url}/api/v1"
        self._base_headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-Drive-Project": self.project_id,
            "X-Drive-Bucket": self.bucket,
            "Accept": "application/json",
            "User-Agent": "drive-sync/1.0",
        }

    def _safe_error_body(self, body: str) -> str:
        if not body:
            return ""
        return body.replace(self.api_key, "[REDACTED]")[:1_000_000]

    def _api_url(self, path: str) -> str:
        return f"{self.api_root}/{path.lstrip('/')}"

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
        *,
        retry_transport: bool,
        retry_status: bool = True,
    ) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        url = self._api_url(path)
        for attempt in range(self.retries + 1):
            request = Request(
                url,
                data=body,
                method=method,
                headers={
                    **self._base_headers,
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                },
            )
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    if not raw:
                        return {}
                    try:
                        decoded = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise ProtocolError(
                            f"Panel returned a non-JSON response from {method} {path}"
                        ) from exc
                    if not isinstance(decoded, dict):
                        raise ProtocolError(f"Panel returned an invalid JSON object from {method} {path}")
                    return decoded
            except HTTPError as exc:
                response_body = ""
                try:
                    response_body = exc.read(1_000_000).decode("utf-8", errors="replace")
                except Exception:
                    pass
                error = DriveHttpError(
                    int(exc.code),
                    f"{method} {path}",
                    body=self._safe_error_body(response_body),
                    retry_after=retry_after_seconds(exc.headers),
                )
                if retry_status and exc.code in RETRYABLE_HTTP_STATUSES and attempt < self.retries:
                    time.sleep(backoff_seconds(attempt, error.retry_after))
                    continue
                raise error
            except (URLError, TimeoutError, socket.timeout, OSError) as exc:
                if retry_transport and attempt < self.retries:
                    time.sleep(backoff_seconds(attempt))
                    continue
                raise AmbiguousRequestError(
                    f"{method} {path} did not return a response; the request may have reached the panel"
                ) from exc
        raise SyncError(f"Request retry loop exhausted for {method} {path}")

    def presign(
        self,
        key: str,
        content_type: str,
        metadata: dict[str, str],
    ) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "files/uploads/presign",
            {
                "projectId": self.project_id,
                "bucket": self.bucket,
                "key": key,
                "contentType": content_type,
                "expiresInSeconds": 3600,
                "metadata": metadata,
            },
            retry_transport=True,
        )

    def start_multipart(self, key: str, content_type: str, metadata: dict[str, str]) -> dict[str, Any]:
        # A lost response after this POST can leave an unreferenced multipart
        # upload.  Do not retry it automatically and persist an explicit
        # "start unknown" state before making the call.
        return self._request_json(
            "POST",
            "files/uploads/multipart",
            {
                "projectId": self.project_id,
                "bucket": self.bucket,
                "key": key,
                "contentType": content_type,
                "metadata": metadata,
            },
            retry_transport=False,
            retry_status=False,
        )

    def sign_part(self, key: str, upload_id: str, part_number: int) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "files/uploads/multipart/part",
            {
                "projectId": self.project_id,
                "bucket": self.bucket,
                "key": key,
                "uploadId": upload_id,
                "partNumber": part_number,
                "expiresInSeconds": 3600,
            },
            retry_transport=True,
        )

    def complete_multipart(self, key: str, upload_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "files/uploads/multipart/complete",
            {
                "projectId": self.project_id,
                "bucket": self.bucket,
                "key": key,
                "uploadId": upload_id,
                "parts": parts,
            },
            retry_transport=False,
            retry_status=False,
        )

    def abort_multipart(self, key: str, upload_id: str) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "files/uploads/multipart/abort",
            {
                "projectId": self.project_id,
                "bucket": self.bucket,
                "key": key,
                "uploadId": upload_id,
            },
            retry_transport=False,
            retry_status=False,
        )

    def finalize(self, key: str) -> dict[str, Any]:
        return self._request_json(
            "PATCH",
            "files/upload",
            {"projectId": self.project_id, "bucket": self.bucket, "key": key},
            retry_transport=True,
        )

    def create_folder(self, key: str) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "files/folders",
            {"projectId": self.project_id, "bucket": self.bucket, "key": key},
            retry_transport=True,
        )

    def put_file(
        self,
        signed_url: str,
        path: Path,
        size: int,
        headers: dict[str, str],
        on_bytes: Callable[[int], None] | None,
    ) -> str | None:
        body = FileSection(path, 0, size, on_bytes)
        try:
            request = Request(
                signed_url,
                data=body,
                method="PUT",
                headers={**headers, "Content-Length": str(size)},
            )
            with urlopen(request, timeout=self.timeout) as response:
                response.read(1024)
                return response.headers.get("ETag") or response.headers.get("Etag")
        except HTTPError as exc:
            response_body = ""
            try:
                response_body = exc.read(1_000_000).decode("utf-8", errors="replace")
            except Exception:
                pass
            raise DriveHttpError(
                int(exc.code),
                f"PUT {redact_url(signed_url)}",
                body=self._safe_error_body(response_body),
                retry_after=retry_after_seconds(exc.headers),
            ) from exc
        except (URLError, TimeoutError, socket.timeout, OSError) as exc:
            raise AmbiguousRequestError(
                f"PUT {redact_url(signed_url)} did not return a response; the object may have been written"
            ) from exc
        finally:
            body.close()

    def put_part(
        self,
        signed_url: str,
        path: Path,
        offset: int,
        size: int,
        on_bytes: Callable[[int], None] | None,
    ) -> str:
        body = FileSection(path, offset, size, on_bytes)
        try:
            request = Request(
                signed_url,
                data=body,
                method="PUT",
                headers={"Content-Length": str(size)},
            )
            with urlopen(request, timeout=self.timeout) as response:
                response.read(1024)
                etag = response.headers.get("ETag") or response.headers.get("Etag")
                if not etag:
                    raise ProtocolError("R2 accepted a multipart part but returned no ETag")
                return etag.strip()
        except HTTPError as exc:
            response_body = ""
            try:
                response_body = exc.read(1_000_000).decode("utf-8", errors="replace")
            except Exception:
                pass
            raise DriveHttpError(
                int(exc.code),
                f"PUT multipart part at {redact_url(signed_url)}",
                body=self._safe_error_body(response_body),
                retry_after=retry_after_seconds(exc.headers),
            ) from exc
        except (URLError, TimeoutError, socket.timeout, OSError) as exc:
            raise AmbiguousRequestError(
                f"Multipart part PUT at {redact_url(signed_url)} did not return a response; retrying the same part is safe"
            ) from exc
        finally:
            body.close()


def scan_sources(
    files: Sequence[Path],
    folder: Path | None,
    prefix: str,
    *,
    include_root: bool,
    preserve_empty_folders: bool,
) -> ScanResult:
    collected: dict[str, FileSnapshot] = {}
    empty: dict[str, FolderSnapshot] = {}
    errors: list[str] = []

    def add_file(path: Path, key: str) -> None:
        normalized_key = normalize_key_part(key, allow_empty=False)
        try:
            snapshot = snapshot_file(path, normalized_key)
        except SyncError as exc:
            errors.append(str(exc))
            return
        previous = collected.get(normalized_key)
        if previous is not None and previous.path != snapshot.path:
            errors.append(
                f"Two selected files map to the same Drive key {normalized_key!r}: "
                f"{previous.path} and {snapshot.path}"
            )
            return
        collected[normalized_key] = snapshot

    if folder is not None:
        root = folder.resolve()
        if not root.exists() or not root.is_dir():
            errors.append(f"Selected folder does not exist or is not a directory: {folder}")
        else:
            root_component = root.name if include_root else ""
            try:
                def on_walk_error(error: OSError) -> None:
                    errors.append(f"Unable to enumerate {error.filename or root}: {error}")

                for current_text, directories, filenames in os.walk(
                    root,
                    topdown=True,
                    onerror=on_walk_error,
                    followlinks=False,
                ):
                    current = Path(current_text)
                    directories.sort(key=str.casefold)
                    filenames.sort(key=str.casefold)
                    # Do not follow directory symlinks.  This prevents loops
                    # and keeps the selected folder as the source boundary.
                    kept_directories: list[str] = []
                    for directory in directories:
                        candidate = current / directory
                        try:
                            if candidate.is_symlink():
                                continue
                        except OSError as exc:
                            errors.append(f"Unable to inspect directory {candidate}: {exc}")
                            continue
                        kept_directories.append(directory)
                    directories[:] = kept_directories

                    try:
                        relative = current.relative_to(root)
                    except ValueError:
                        errors.append(f"Folder traversal escaped its root: {current}")
                        continue
                    relative_text = "" if str(relative) == "." else str(relative)
                    base_parts = [prefix, root_component, relative_text]
                    if not filenames and not directories and preserve_empty_folders and relative_text:
                        empty_key = join_key(*base_parts, trailing_slash=True)
                        empty[empty_key] = FolderSnapshot(current, empty_key)

                    for filename in filenames:
                        source = current / filename
                        relative_file = Path(relative_text) / filename if relative_text else Path(filename)
                        key = join_key(prefix, root_component, str(relative_file))
                        add_file(source, key)
            except OSError as exc:
                errors.append(f"Unable to enumerate {root}: {exc}")

            # An entirely empty selected folder still deserves a placeholder
            # when the root itself is included in the destination key.
            if preserve_empty_folders and include_root and not collected and not empty:
                empty_key = join_key(prefix, root_component, trailing_slash=True)
                empty[empty_key] = FolderSnapshot(root, empty_key)
    else:
        for source_text in files:
            source = source_text.resolve()
            add_file(source, join_key(prefix, source.name))

    return ScanResult(
        files=tuple(sorted(collected.values(), key=lambda item: item.key.casefold())),
        empty_folders=tuple(sorted(empty.values(), key=lambda item: item.key.casefold())),
        errors=tuple(errors),
    )


def multipart_part_size(file_size: int, requested: int) -> int:
    if requested < MIN_MULTIPART_PART_SIZE:
        raise SyncError(f"Multipart part size must be at least {format_bytes(MIN_MULTIPART_PART_SIZE)}")
    if requested > MAX_MULTIPART_PART_SIZE:
        raise SyncError(f"Multipart part size cannot exceed {format_bytes(MAX_MULTIPART_PART_SIZE)}")
    if file_size <= 0:
        return requested
    minimum = (file_size + MAX_MULTIPART_PARTS - 1) // MAX_MULTIPART_PARTS
    chosen = max(requested, minimum)
    # Alignment is not required by R2, but it makes resumed layouts stable
    # and keeps offsets easy to inspect.
    alignment = 1024 * 1024
    chosen = ((chosen + alignment - 1) // alignment) * alignment
    if chosen > MAX_MULTIPART_PART_SIZE:
        raise SyncError("The file is too large for the supported multipart limits")
    return chosen


def part_layout(file_size: int, part_size: int) -> list[tuple[int, int, int]]:
    if file_size <= 0:
        return []
    result: list[tuple[int, int, int]] = []
    offset = 0
    part_number = 1
    while offset < file_size:
        length = min(part_size, file_size - offset)
        result.append((part_number, offset, length))
        part_number += 1
        offset += length
    if len(result) > MAX_MULTIPART_PARTS:
        raise SyncError("The file requires more than 10,000 multipart parts")
    return result


class SyncRunner:
    def __init__(
        self,
        client: DriveClient,
        state: StateStore,
        scan: ScanResult,
        *,
        single_threshold: int,
        requested_part_size: int,
        file_workers: int,
        part_workers: int,
        retries: int,
        finalize_timeout: float,
        preserve_empty_folders: bool,
        reset_ambiguous: bool,
        quiet: bool,
    ) -> None:
        self.client = client
        self.state = state
        self.scan = scan
        self.single_threshold = single_threshold
        self.requested_part_size = requested_part_size
        self.file_workers = file_workers
        self.part_workers = part_workers
        self.retries = retries
        self.finalize_timeout = finalize_timeout
        self.preserve_empty_folders = preserve_empty_folders
        self.reset_ambiguous = reset_ambiguous
        self.quiet = quiet
        self.progress = ProgressReporter(scan.files, quiet=quiet)

    def prepare_state(self) -> None:
        # Source changes invalidate an old multipart layout.  Try to abort it
        # before replacing the local record; failure is reported but never
        # allowed to destroy the local source or hide the new snapshot.
        for snapshot in self.scan.files:
            marker = source_fingerprint(
                self.client.project_id,
                self.client.bucket,
                snapshot.key,
                snapshot.size,
                snapshot.mtime_ns,
            )
            content_type = content_type_for(snapshot.path)
            part_size = multipart_part_size(snapshot.size, self.requested_part_size)
            record = self.state.get_file(snapshot.key)
            if record is None:
                self.state.replace_file(
                    snapshot,
                    content_type,
                    part_size,
                    marker,
                    "multipart" if snapshot.size >= self.single_threshold else "single",
                )
                continue
            same_source = self._record_matches_snapshot(record, snapshot)
            if record.get("status") == "ambiguous_multipart_start" and not self.reset_ambiguous:
                # Keep the barrier.  Starting another multipart upload here
                # would be the exact duplicate-start failure the state file is
                # meant to prevent.
                continue
            if same_source:
                self.state.ensure_file_fields(
                    snapshot.key,
                    content_type=content_type,
                    part_size=part_size,
                    marker=marker,
                )
                continue
            self._abort_record_multipart(record, snapshot.key)
            self.state.replace_file(
                snapshot,
                content_type,
                part_size,
                marker,
                "multipart" if snapshot.size >= self.single_threshold else "single",
            )

        for folder in self.scan.empty_folders:
            record = self.state.get_folder(folder.key)
            if record is None or record.get("sourcePath") != str(folder.path):
                self.state.replace_folder(folder)

        self.progress.seed(self.state.all_file_records())

    def run(self) -> dict[str, int]:
        self.prepare_state()
        folder_stats = self._run_empty_folders()
        stats = {"uploaded": 0, "skipped": 0, "failed": 0, **folder_stats}

        if self.scan.files:
            with ThreadPoolExecutor(
                max_workers=self.file_workers,
                thread_name_prefix="drive-file",
            ) as executor:
                futures = {
                    executor.submit(self.process_file, item): item for item in self.scan.files
                }
                for future in as_completed(futures):
                    item = futures[future]
                    try:
                        result = future.result()
                        stats[result] = stats.get(result, 0) + 1
                    except Exception as exc:
                        stats["failed"] += 1
                        if not self.quiet:
                            print(f"\nFAILED {item.key}: {safe_exception_text(exc)}", file=sys.stderr)

        self.progress.finish()
        return stats

    def _run_empty_folders(self) -> dict[str, int]:
        result = {"folders_uploaded": 0, "folders_skipped": 0, "folders_failed": 0}
        if not self.preserve_empty_folders:
            return result
        for folder in self.scan.empty_folders:
            record = self.state.get_folder(folder.key)
            if record and record.get("status") == "complete":
                result["folders_skipped"] += 1
                continue
            try:
                self.state.update_folder(folder.key, status="creating", lastError=None)
                self.client.create_folder(folder.key)
                self.state.update_folder(folder.key, status="complete", completedAt=utc_now())
                result["folders_uploaded"] += 1
                if not self.quiet:
                    print(f"Folder ready: {folder.key}")
            except Exception as exc:
                self.state.update_folder(folder.key, status="failed", lastError=safe_exception_text(exc))
                result["folders_failed"] += 1
                if not self.quiet:
                    print(f"\nFAILED folder {folder.key}: {safe_exception_text(exc)}", file=sys.stderr)
        return result

    def _abort_record_multipart(self, record: dict[str, Any], key: str) -> None:
        upload_id = str(record.get("uploadId") or "")
        if (
            not upload_id
            or record.get("uploadType") != "multipart"
            or record.get("status") == "complete"
        ):
            return
        try:
            self.client.abort_multipart(key, upload_id)
        except Exception as exc:
            if not self.quiet:
                print(
                    f"Warning: could not retire old multipart upload for {key}: {safe_exception_text(exc)}",
                    file=sys.stderr,
                )

    def _reset_for_snapshot(self, snapshot: FileSnapshot) -> None:
        old = self.state.get_file(snapshot.key)
        if old is not None:
            self._abort_record_multipart(old, snapshot.key)
        marker = source_fingerprint(
            self.client.project_id,
            self.client.bucket,
            snapshot.key,
            snapshot.size,
            snapshot.mtime_ns,
        )
        self.state.replace_file(
            snapshot,
            content_type_for(snapshot.path),
            multipart_part_size(snapshot.size, self.requested_part_size),
            marker,
            "multipart" if snapshot.size >= self.single_threshold else "single",
        )

    def process_file(self, planned: FileSnapshot) -> str:
        key = planned.key
        for source_round in range(MAX_SOURCE_RESTARTS + 1):
            current = snapshot_file(planned.path, key)
            record = self.state.get_file(key)
            if record is None or not self._record_matches_snapshot(record, current):
                self._reset_for_snapshot(current)
                record = self.state.get_file(key)
            if record and record.get("status") == "complete":
                marker = source_fingerprint(
                    self.client.project_id,
                    self.client.bucket,
                    current.key,
                    current.size,
                    current.mtime_ns,
                )
                try:
                    self._verify_finalized(
                        current,
                        marker,
                        timeout=min(8.0, self.finalize_timeout),
                    )
                except (PendingVerification, VerificationError):
                    # The durable state was once verified, but the remote
                    # object is now absent, replaced, or has the wrong size.
                    # Repair the same logical key instead of trusting stale
                    # state or creating a new destination key.
                    self._reset_for_snapshot(current)
                    record = self.state.get_file(key)
                except Exception as exc:
                    self.state.update_file(key, status="failed", lastError=safe_exception_text(exc))
                    raise
                else:
                    self.progress.mark_skipped(key)
                    return "skipped"

            try:
                if current.size >= self.single_threshold:
                    self._upload_multipart(current)
                else:
                    self._upload_single(current)
                self._verify_finalized(
                    current,
                    source_fingerprint(
                        self.client.project_id,
                        self.client.bucket,
                        current.key,
                        current.size,
                        current.mtime_ns,
                    ),
                    timeout=self.finalize_timeout,
                )
                if not snapshot_matches(current.path, current):
                    newest = snapshot_file(current.path, key)
                    self._reset_for_snapshot(newest)
                    if source_round < MAX_SOURCE_RESTARTS:
                        continue
                    raise VerificationError(
                        f"Source kept changing while uploading {current.path}; last upload was not marked complete"
                    )
                final_record = self.state.get_file(key) or {}
                self.state.update_file(
                    key,
                    status="complete",
                    completedAt=utc_now(),
                    size=current.size,
                    mtimeNs=current.mtime_ns,
                    marker=source_fingerprint(
                        self.client.project_id,
                        self.client.bucket,
                        current.key,
                        current.size,
                        current.mtime_ns,
                    ),
                    remoteEtag=final_record.get("remoteEtag"),
                    lastError=None,
                )
                self.progress.mark_complete(key)
                return "uploaded"
            except Exception as exc:
                state_record = self.state.get_file(key) or {}
                if state_record.get("status") != "ambiguous_multipart_start":
                    self.state.update_file(key, status="failed", lastError=safe_exception_text(exc))
                raise
        raise SyncError(f"Unable to stabilize source file: {planned.path}")

    @staticmethod
    def _record_matches_snapshot(record: dict[str, Any], snapshot: FileSnapshot) -> bool:
        try:
            return (
                record.get("sourcePath") == str(snapshot.path)
                and int(record.get("size", -1)) == snapshot.size
                and int(record.get("mtimeNs", -1)) == snapshot.mtime_ns
            )
        except (TypeError, ValueError):
            return False

    def _upload_single(self, snapshot: FileSnapshot) -> None:
        marker = source_fingerprint(
            self.client.project_id,
            self.client.bucket,
            snapshot.key,
            snapshot.size,
            snapshot.mtime_ns,
        )
        record = self.state.get_file(snapshot.key) or {}
        if record.get("status") == "single_finalizing":
            try:
                self._verify_finalized(snapshot, marker, timeout=min(8.0, self.finalize_timeout))
                return
            except (PendingVerification, VerificationError, DriveHttpError, AmbiguousRequestError):
                pass

        metadata = {METADATA_NAME: marker}
        attempts = int(record.get("attempts", 0) or 0)
        self.state.update_file(
            snapshot.key,
            status="single_presigning",
            uploadType="single",
            marker=marker,
            contentType=content_type_for(snapshot.path),
            attempts=attempts + 1,
            lastError=None,
        )
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                presigned = self.client.presign(
                    snapshot.key,
                    content_type_for(snapshot.path),
                    metadata,
                )
                upload_url = presigned.get("url")
                if not isinstance(upload_url, str) or not upload_url:
                    raise ProtocolError("Panel presign response did not contain a URL")
                headers = {
                    "Content-Type": content_type_for(snapshot.path),
                    f"x-amz-meta-{METADATA_NAME}": marker,
                }
                response_headers = presigned.get("headers")
                if isinstance(response_headers, dict):
                    for name, value in response_headers.items():
                        if isinstance(name, str) and isinstance(value, (str, int, float)):
                            headers[name] = str(value)
                self.state.update_file(snapshot.key, status="single_uploading", lastError=None)
                self.client.put_file(
                    upload_url,
                    snapshot.path,
                    snapshot.size,
                    headers,
                    lambda amount: self.progress.add(snapshot.key, amount),
                )
                self.state.update_file(snapshot.key, status="single_finalizing", lastError=None)
                return
            except (DriveHttpError, AmbiguousRequestError, OSError, socket.timeout) as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                if isinstance(exc, DriveHttpError) and exc.status not in RETRYABLE_HTTP_STATUSES and exc.status != 403:
                    break
                time.sleep(backoff_seconds(attempt, exc.retry_after if isinstance(exc, DriveHttpError) else None))
        if last_error is not None:
            raise last_error
        raise SyncError(f"Single upload failed for {snapshot.key}")

    def _upload_multipart(self, snapshot: FileSnapshot) -> None:
        marker = source_fingerprint(
            self.client.project_id,
            self.client.bucket,
            snapshot.key,
            snapshot.size,
            snapshot.mtime_ns,
        )
        record = self.state.get_file(snapshot.key) or {}
        upload_id = str(record.get("uploadId") or "")
        if record.get("status") == "ambiguous_multipart_start" and not self.reset_ambiguous:
            raise AmbiguousMultipartStart(
                f"Multipart start for {snapshot.key} has an unknown result. "
                "The state was deliberately not started again; inspect/retire the incomplete upload, "
                "then rerun with --reset-ambiguous if necessary."
            )

        part_size = int(record.get("partSize") or multipart_part_size(snapshot.size, self.requested_part_size))
        layout = part_layout(snapshot.size, part_size)
        if not upload_id:
            self.state.update_file(
                snapshot.key,
                status="multipart_starting",
                uploadType="multipart",
                partSize=part_size,
                marker=marker,
                contentType=content_type_for(snapshot.path),
                lastError=None,
            )
            try:
                started = self.client.start_multipart(
                    snapshot.key,
                    content_type_for(snapshot.path),
                    {METADATA_NAME: marker},
                )
            except (AmbiguousRequestError, ProtocolError, URLError, TimeoutError, socket.timeout, OSError) as exc:
                self.state.update_file(
                    snapshot.key,
                    status="ambiguous_multipart_start",
                    lastError="Multipart start may have reached the panel; no second start was attempted",
                )
                raise AmbiguousMultipartStart(
                    f"Multipart start for {snapshot.key} may have reached the panel; "
                    "the state was left behind to prevent a duplicate start"
                ) from exc
            except DriveHttpError as exc:
                # The panel's lock-check failure response is emitted before
                # multipart creation, so it is safe to retry on a later run.
                # Other 5xx responses may be ambiguous because R2 could have
                # accepted the multipart-start request before the panel failed.
                if exc.api_code == "LOCK_CHECK_UNAVAILABLE":
                    raise
                if exc.status in RETRYABLE_HTTP_STATUSES:
                    self.state.update_file(
                        snapshot.key,
                        status="ambiguous_multipart_start",
                        lastError="Multipart start returned a transient error; no second start was attempted",
                    )
                    raise AmbiguousMultipartStart(
                        f"Multipart start for {snapshot.key} returned HTTP {exc.status}; "
                        "the state was left behind to prevent a duplicate start"
                    ) from exc
                raise
            upload_id_value = started.get("uploadId")
            if not isinstance(upload_id_value, str) or not upload_id_value:
                raise ProtocolError("Panel multipart start response did not contain uploadId")
            upload_id = upload_id_value
            # Persist the upload ID before asking for the first signed part.
            self.state.update_file(
                snapshot.key,
                status="multipart_uploading",
                uploadId=upload_id,
                parts={},
                lastError=None,
            )

        record = self.state.get_file(snapshot.key) or {}
        stored_parts = record.get("parts") if isinstance(record.get("parts"), dict) else {}
        missing = [item for item in layout if not self._part_record_is_valid(stored_parts.get(str(item[0])), item[2])]
        if missing:
            self.state.update_file(snapshot.key, status="multipart_uploading", lastError=None)
            self._upload_missing_parts(snapshot, upload_id, missing, stored_parts)

        record = self.state.get_file(snapshot.key) or {}
        parts_state = record.get("parts") if isinstance(record.get("parts"), dict) else {}
        complete_parts: list[dict[str, Any]] = []
        for number, _offset, size in layout:
            item = parts_state.get(str(number))
            if not self._part_record_is_valid(item, size):
                raise SyncError(f"Multipart part {number} is not durably recorded for {snapshot.key}")
            complete_parts.append({"partNumber": number, "etag": str(item["etag"])})

        if record.get("status") == "multipart_completing":
            try:
                self._verify_finalized(snapshot, marker, timeout=min(8.0, self.finalize_timeout))
                return
            except (PendingVerification, VerificationError, DriveHttpError, AmbiguousRequestError):
                pass

        self.state.update_file(snapshot.key, status="multipart_completing", lastError=None)
        try:
            self.client.complete_multipart(snapshot.key, upload_id, complete_parts)
        except Exception as exc:
            # CompleteMultipartUpload can commit successfully before the
            # response is lost.  Confirm the object before exposing the error.
            try:
                verified = self._verify_finalized(snapshot, marker, timeout=min(8.0, self.finalize_timeout))
                self.state.update_file(
                    snapshot.key,
                    remoteEtag=verified.get("etag"),
                    status="multipart_completing",
                    lastError=None,
                )
                return
            except Exception:
                raise exc

    @staticmethod
    def _part_record_is_valid(value: Any, expected_size: int) -> bool:
        if not isinstance(value, dict) or not value.get("etag"):
            return False
        try:
            return int(value.get("size", -1)) == expected_size
        except (TypeError, ValueError):
            return False

    def _upload_missing_parts(
        self,
        snapshot: FileSnapshot,
        upload_id: str,
        missing: Sequence[tuple[int, int, int]],
        stored_parts: dict[str, Any],
    ) -> None:
        def upload_one(item: tuple[int, int, int]) -> tuple[int, int, str]:
            part_number, offset, size = item
            last_error: Exception | None = None
            for attempt in range(self.retries + 1):
                try:
                    signed = self.client.sign_part(snapshot.key, upload_id, part_number)
                    signed_url = signed.get("url")
                    if not isinstance(signed_url, str) or not signed_url:
                        raise ProtocolError(f"No signed URL returned for multipart part {part_number}")
                    etag = self.client.put_part(
                        signed_url,
                        snapshot.path,
                        offset,
                        size,
                        lambda amount: self.progress.add(snapshot.key, amount),
                    )
                    return part_number, size, etag
                except (DriveHttpError, AmbiguousRequestError, OSError, socket.timeout) as exc:
                    last_error = exc
                    if attempt >= self.retries:
                        break
                    if isinstance(exc, DriveHttpError) and exc.status not in RETRYABLE_HTTP_STATUSES and exc.status != 403:
                        break
                    time.sleep(backoff_seconds(attempt, exc.retry_after if isinstance(exc, DriveHttpError) else None))
            if last_error is not None:
                raise last_error
            raise SyncError(f"Multipart part {part_number} failed for {snapshot.key}")

        with ThreadPoolExecutor(
            max_workers=min(self.part_workers, max(1, len(missing))),
            thread_name_prefix="drive-part",
        ) as executor:
            futures = {executor.submit(upload_one, item): item for item in missing}
            first_error: Exception | None = None
            for future in as_completed(futures):
                try:
                    part_number, size, etag = future.result()
                    self.state.mark_part_uploaded(snapshot.key, part_number, size, etag)
                except Exception as exc:
                    if first_error is None:
                        first_error = exc
            if first_error is not None:
                raise first_error

    def _verify_finalized(self, snapshot: FileSnapshot, marker: str, *, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + max(1.0, timeout)
        attempt = 0
        last_pending: str | None = None
        while True:
            try:
                result = self.client.finalize(snapshot.key)
            except DriveHttpError as exc:
                if exc.status in RETRYABLE_HTTP_STATUSES and time.monotonic() < deadline:
                    time.sleep(backoff_seconds(attempt, exc.retry_after))
                    attempt += 1
                    continue
                raise
            except (AmbiguousRequestError, URLError, TimeoutError, socket.timeout, OSError):
                if time.monotonic() < deadline:
                    time.sleep(backoff_seconds(attempt))
                    attempt += 1
                    continue
                raise

            if result.get("pending") is True or result.get("size") is None:
                last_pending = "panel has not observed the committed object yet"
            else:
                try:
                    remote_size = int(result.get("size"))
                except (TypeError, ValueError) as exc:
                    raise ProtocolError("Finalize response did not contain a numeric object size") from exc
                if remote_size != snapshot.size:
                    raise VerificationError(
                        f"Exact-size verification failed for {snapshot.key}: "
                        f"local={snapshot.size}, remote={remote_size}"
                    )
                metadata = result.get("metadata")
                remote_marker = ""
                if isinstance(metadata, dict):
                    remote_marker = str(
                        metadata.get(METADATA_NAME)
                        or metadata.get(f"x-amz-meta-{METADATA_NAME}")
                        or ""
                    )
                if remote_marker != marker:
                    raise VerificationError(
                        f"Metadata verification failed for {snapshot.key}; "
                        "the object size matched but its sync fingerprint did not"
                    )
                self.state.update_file(
                    snapshot.key,
                    remoteEtag=result.get("etag"),
                    remoteSize=remote_size,
                    remoteMetadata=metadata if isinstance(metadata, dict) else {},
                )
                return result

            if time.monotonic() >= deadline:
                raise PendingVerification(
                    f"Finalize is still pending for {snapshot.key}: {last_pending or 'object not visible'}"
                )
            time.sleep(min(2.0, backoff_seconds(attempt)))
            attempt += 1


def default_state_path(identity: dict[str, Any]) -> Path:
    serialized = json.dumps(identity, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(serialized).hexdigest()[:24]
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "DriveSync" / "state" / f"{digest}.json"


def prompt_text(label: str, current: str = "") -> str:
    suffix = f" [{current}]" if current else ""
    answer = input(f"{label}{suffix}: ").strip()
    return answer or current


def choose_sources_with_picker() -> tuple[list[Path], Path | None]:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox
    except ImportError as exc:
        raise SyncError(
            "Tkinter is unavailable; provide --file or --folder explicitly"
        ) from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        choose_folder = messagebox.askyesno(
            "Drive Sync",
            "Choose a folder?\n\nChoose No to select individual files.",
            parent=root,
        )
        if choose_folder:
            selected = filedialog.askdirectory(title="Select the folder to sync", parent=root)
            if not selected:
                raise SyncError("No folder was selected")
            return [], Path(selected)
        selected_files = filedialog.askopenfilenames(title="Select files to sync", parent=root)
        if not selected_files:
            raise SyncError("No files were selected")
        return [Path(item) for item in selected_files], None
    finally:
        root.destroy()


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SyncError(f"Unable to read config file {path}") from exc
    if not isinstance(loaded, dict):
        raise SyncError("Config file must contain a JSON object")
    return loaded


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Upload selected files or a complete folder tree to Drive with crash-safe resume."
    )
    parser.add_argument("--panel-url", help="Drive panel URL, e.g. https://drive.example.com")
    parser.add_argument("--project-id", help="Drive project ID")
    parser.add_argument("--bucket", help="Project-assigned bucket name")
    parser.add_argument(
        "--api-key",
        help="Drive API key (prefer the hidden prompt or DRIVE_API_KEY instead of command-line history)",
    )
    parser.add_argument("--config", type=Path, help="Optional JSON config with panel_url/project_id/bucket/api_key")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--folder", type=Path, help="Folder to recursively sync")
    source.add_argument("--file", dest="files", type=Path, action="append", help="File to sync; repeatable")
    parser.add_argument("--select", action="store_true", help="Open the Windows file/folder picker")
    parser.add_argument("--prefix", default="", help="Destination key prefix")
    parser.add_argument(
        "--contents-only",
        action="store_true",
        help="For a folder source, omit the selected folder name from destination keys",
    )
    empty = parser.add_mutually_exclusive_group()
    empty.add_argument("--preserve-empty-folders", dest="preserve_empty", action="store_true", default=True)
    empty.add_argument("--no-preserve-empty-folders", dest="preserve_empty", action="store_false")
    parser.add_argument("--state-file", type=Path, help="Resume state path (default: %%LOCALAPPDATA%%/DriveSync/state)")
    parser.add_argument("--workers", type=lambda value: parse_positive_int(value, "workers"), default=3)
    parser.add_argument("--part-workers", type=lambda value: parse_positive_int(value, "part-workers"), default=4)
    parser.add_argument(
        "--single-threshold-mb",
        type=lambda value: parse_positive_int(value, "single-threshold-mb"),
        default=DEFAULT_SINGLE_THRESHOLD // (1024 * 1024),
        help="Use multipart at or above this file size (default: 64)",
    )
    parser.add_argument(
        "--part-size-mb",
        type=lambda value: parse_positive_int(value, "part-size-mb"),
        default=DEFAULT_PART_SIZE // (1024 * 1024),
        help="Multipart part size (minimum 5 MiB; default: 64)",
    )
    parser.add_argument("--retries", type=lambda value: parse_positive_int(value, "retries"), default=5)
    parser.add_argument("--timeout", type=float, default=120.0, help="Per-request socket timeout in seconds")
    parser.add_argument("--finalize-timeout", type=float, default=60.0, help="Object visibility verification window")
    parser.add_argument(
        "--reset-ambiguous",
        action="store_true",
        help="Clear a state barrier after an unknown multipart-start result; use only after checking for an orphan upload",
    )
    parser.add_argument("--dry-run", action="store_true", help="Scan and print the selection without uploading")
    parser.add_argument("--non-interactive", action="store_true", help="Do not prompt for missing configuration or sources")
    parser.add_argument("--quiet", action="store_true", help="Reduce progress output")
    return parser


def required_value(
    explicit: str | None,
    config: dict[str, Any],
    config_names: Sequence[str],
    env_names: Sequence[str],
    label: str,
    *,
    secret: bool = False,
    non_interactive: bool,
) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    for name in config_names:
        value = config.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for name in env_names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    if non_interactive:
        raise SyncError(f"Missing {label}; provide the command-line, config, or environment value")
    if secret:
        value = getpass.getpass(f"{label}: ").strip()
    else:
        value = prompt_text(label)
    if not value:
        raise SyncError(f"{label} is required")
    return value


def resolve_sources(args: argparse.Namespace) -> tuple[list[Path], Path | None]:
    if args.select:
        if args.folder is not None or args.files:
            raise SyncError("--select cannot be combined with --file or --folder")
        return choose_sources_with_picker()
    if args.folder is not None:
        return [], args.folder
    if args.files:
        return list(args.files), None
    if args.non_interactive:
        raise SyncError("Provide --file/--folder when --non-interactive is enabled")
    return choose_sources_with_picker()


def print_scan(scan: ScanResult, state_path: Path | None = None) -> None:
    print(f"Files: {len(scan.files)} ({format_bytes(sum(item.size for item in scan.files))})")
    print(f"Empty folders: {len(scan.empty_folders)}")
    if state_path is not None:
        print(f"Resume state: {state_path}")
    for error in scan.errors:
        print(f"Scan error: {error}", file=sys.stderr)
    if scan.files and len(scan.files) <= 20:
        for item in scan.files:
            print(f"  {item.key}  <-  {item.path}  ({format_bytes(item.size)})")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.workers > MAX_FILE_WORKERS or args.part_workers > MAX_PART_WORKERS:
        raise SyncError(f"workers are bounded at {MAX_FILE_WORKERS}; part-workers at {MAX_PART_WORKERS}")
    if args.timeout <= 0 or args.finalize_timeout <= 0:
        raise SyncError("timeout and finalize-timeout must be greater than zero")

    config = load_config(args.config)
    panel_url = required_value(
        args.panel_url,
        config,
        ("panel_url", "drive_url"),
        ("DRIVE_PANEL_URL", "DRIVE_URL"),
        "Panel URL",
        non_interactive=args.non_interactive,
    )
    project_id = required_value(
        args.project_id,
        config,
        ("project_id",),
        ("DRIVE_PROJECT_ID",),
        "Project ID",
        non_interactive=args.non_interactive,
    )
    bucket = required_value(
        args.bucket,
        config,
        ("bucket", "bucket_name"),
        ("DRIVE_BUCKET",),
        "Bucket",
        non_interactive=args.non_interactive,
    )
    api_key = required_value(
        args.api_key,
        config,
        ("api_key", "drive_api_key"),
        ("DRIVE_API_KEY",),
        "Drive API key",
        secret=True,
        non_interactive=args.non_interactive,
    )
    normalized_panel_url = normalize_panel_url(panel_url)
    normalized_prefix = normalize_key_part(args.prefix)
    files, folder = resolve_sources(args)
    scan = scan_sources(
        files,
        folder,
        normalized_prefix,
        include_root=not args.contents_only,
        preserve_empty_folders=args.preserve_empty,
    )
    state_identity = {
        "panelUrl": normalized_panel_url,
        "projectId": project_id.strip(),
        "bucket": bucket.strip(),
        "prefix": normalized_prefix,
        "source": {
            "folder": str(folder.resolve()) if folder is not None else None,
            "files": sorted(str(item.resolve()) for item in files),
            "includeRoot": not args.contents_only,
            "preserveEmptyFolders": bool(args.preserve_empty),
        },
    }
    state_path = args.state_file.expanduser().resolve() if args.state_file else default_state_path(state_identity)
    print_scan(scan, state_path)
    if scan.errors:
        raise SyncError("Scan failed; no upload was started")
    if args.dry_run:
        return 0
    if not scan.files and not scan.empty_folders:
        print("Nothing selected to upload.")
        return 0

    requested_part_size = args.part_size_mb * 1024 * 1024
    single_threshold = args.single_threshold_mb * 1024 * 1024
    if single_threshold <= 0:
        raise SyncError("single-threshold-mb must be greater than zero")
    # Validate the configured size even when this particular selection only
    # contains small files; future resumes must not inherit an invalid layout.
    multipart_part_size(max(single_threshold, 1), requested_part_size)

    client = DriveClient(
        normalized_panel_url,
        project_id,
        bucket,
        api_key,
        timeout=args.timeout,
        retries=args.retries,
    )
    lock_path = Path(f"{state_path}.lock")
    with ProcessFileLock(lock_path):
        state = StateStore.load(state_path, state_identity)
        runner = SyncRunner(
            client,
            state,
            scan,
            single_threshold=single_threshold,
            requested_part_size=requested_part_size,
            file_workers=args.workers,
            part_workers=args.part_workers,
            retries=args.retries,
            finalize_timeout=args.finalize_timeout,
            preserve_empty_folders=args.preserve_empty,
            reset_ambiguous=args.reset_ambiguous,
            quiet=args.quiet,
        )
        stats = runner.run()

    print(
        "Completed: "
        f"uploaded={stats.get('uploaded', 0)}, skipped={stats.get('skipped', 0)}, "
        f"failed={stats.get('failed', 0)}, empty-folders-uploaded={stats.get('folders_uploaded', 0)}, "
        f"empty-folders-failed={stats.get('folders_failed', 0)}"
    )
    return 1 if stats.get("failed", 0) or stats.get("folders_failed", 0) else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nStopped. Completed files and multipart parts remain in the resume state.", file=sys.stderr)
        raise SystemExit(130)
    except SyncError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
