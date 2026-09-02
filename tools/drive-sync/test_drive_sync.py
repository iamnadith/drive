from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import drive_sync as sync


class MockDriveHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *args: object) -> None:
        return

    @property
    def store(self) -> dict:
        return self.server.store  # type: ignore[attr-defined]

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def require_panel_auth(self) -> bool:
        if self.headers.get("Authorization") != "Bearer test-key":
            self.send_json(401, {"error": "bad auth"})
            return False
        return True

    def do_POST(self) -> None:
        if not self.require_panel_auth():
            return
        body = json.loads(self.read_body().decode("utf-8"))
        path = self.path
        if path == "/api/v1/files/uploads/presign":
            key = body["key"]
            self.store["presign_calls"] += 1
            self.send_json(
                200,
                {
                    "uploadType": "single",
                    "method": "PUT",
                    "url": f"http://127.0.0.1:{self.server.server_port}/signed/single/{key}",  # type: ignore[attr-defined]
                    "key": key,
                    "headers": {"Content-Type": body["contentType"]},
                },
            )
            return
        if path == "/api/v1/files/uploads/multipart":
            if self.store.get("lock_check_unavailable"):
                self.send_json(
                    503,
                    {
                        "error": "Unable to verify object lock",
                        "code": "LOCK_CHECK_UNAVAILABLE",
                    },
                )
                return
            upload_id = f"upload-{len(self.store['sessions']) + 1}"
            self.store["sessions"][upload_id] = {
                "key": body["key"],
                "parts": {},
                "metadata": body.get("metadata", {}),
            }
            self.send_json(200, {"uploadType": "multipart", "uploadId": upload_id, "key": body["key"]})
            return
        if path == "/api/v1/files/uploads/multipart/part":
            upload_id = body["uploadId"]
            part_number = int(body["partNumber"])
            self.send_json(
                200,
                {
                    "method": "PUT",
                    "url": f"http://127.0.0.1:{self.server.server_port}/signed/part/{upload_id}/{part_number}",  # type: ignore[attr-defined]
                    "key": body["key"],
                    "uploadId": upload_id,
                    "partNumber": part_number,
                },
            )
            return
        if path == "/api/v1/files/uploads/multipart/complete":
            session = self.store["sessions"][body["uploadId"]]
            self.store["complete_parts"] = body["parts"]
            expected = sorted(int(number) for number in session["parts"])
            actual = [int(part["partNumber"]) for part in body["parts"]]
            if actual != expected:
                self.send_json(400, {"error": "parts not sorted"})
                return
            session_bytes = b"".join(session["parts"][str(number)] for number in expected)
            self.store["objects"][session["key"]] = {
                "bytes": session_bytes,
                "metadata": {sync.METADATA_NAME: session["metadata"][sync.METADATA_NAME]},
            }
            self.send_json(200, {"ok": True, "key": session["key"]})
            return
        if path == "/api/v1/files/uploads/multipart/abort":
            self.store["sessions"].pop(body["uploadId"], None)
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"error": "unknown POST"})

    def do_PATCH(self) -> None:
        if not self.require_panel_auth():
            return
        body = json.loads(self.read_body().decode("utf-8"))
        key = body["key"]
        self.store["finalize_calls"] += 1
        obj = self.store["objects"].get(key)
        if obj is None:
            self.send_json(202, {"ok": True, "pending": True, "size": None})
            return
        # Exercise the client's pending polling path once for each direct key.
        if key not in self.store["pending_seen"] and key.startswith("single/"):
            self.store["pending_seen"].add(key)
            self.send_json(202, {"ok": True, "pending": True, "size": None})
            return
        self.send_json(
            200,
            {
                "ok": True,
                "pending": False,
                "key": key,
                "size": len(obj["bytes"]),
                "etag": '"mock-etag"',
                "metadata": obj["metadata"],
            },
        )

    def do_PUT(self) -> None:
        data = self.read_body()
        path = self.path.split("?", 1)[0]
        if path.startswith("/signed/single/"):
            key = unquote(path[len("/signed/single/"):])
            if self.headers.get("Authorization") or self.headers.get("X-Drive-Project"):
                self.send_error(400, "panel headers leaked to signed URL")
                return
            marker = self.headers.get(f"x-amz-meta-{sync.METADATA_NAME}")
            self.store["objects"][key] = {"bytes": data, "metadata": {sync.METADATA_NAME: marker}}
            self.store["single_puts"] += 1
            self.send_response(200)
            self.send_header("ETag", '"single-etag"')
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        if path.startswith("/signed/part/"):
            _, _empty, _signed, upload_id, raw_number = path.split("/", 4)
            part_number = int(raw_number)
            if self.headers.get("Authorization") or self.headers.get("X-Drive-Project"):
                self.send_error(400, "panel headers leaked to signed URL")
                return
            self.store["sessions"][upload_id]["parts"][str(part_number)] = data
            self.send_response(200)
            self.send_header("ETag", f'"part-{part_number}"')
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        self.send_error(404, "unknown signed URL")


def start_mock() -> tuple[ThreadingHTTPServer, threading.Thread]:
    store = {
        "objects": {},
        "sessions": {},
        "presign_calls": 0,
        "single_puts": 0,
        "finalize_calls": 0,
        "pending_seen": set(),
        "complete_parts": [],
        "lock_check_unavailable": False,
    }
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockDriveHandler)
    server.store = store  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


class DriveSyncTests(unittest.TestCase):
    def test_scan_and_part_layout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "Source Folder"
            (root / "nested").mkdir(parents=True)
            (root / "nested" / "a.bin").write_bytes(b"abc")
            (root / "empty").mkdir()
            result = sync.scan_sources([], root, "incoming", include_root=True, preserve_empty_folders=True)
            self.assertEqual([item.key for item in result.files], ["incoming/Source Folder/nested/a.bin"])
            self.assertEqual([item.key for item in result.empty_folders], ["incoming/Source Folder/empty/"])
        self.assertEqual(
            sync.part_layout(11 * 1024 * 1024, 5 * 1024 * 1024),
            [(1, 0, 5 * 1024 * 1024), (2, 5 * 1024 * 1024, 5 * 1024 * 1024), (3, 10 * 1024 * 1024, 1024 * 1024)],
        )

    def run_runner(self, snapshot: sync.FileSnapshot, server: ThreadingHTTPServer, state_path: Path, threshold: int, part_size: int) -> dict[str, int]:
        identity = {
            "panelUrl": f"http://127.0.0.1:{server.server_port}",
            "projectId": "project",
            "bucket": "bucket",
            "prefix": "",
            "source": {"files": [str(snapshot.path)], "folder": None, "includeRoot": True, "preserveEmptyFolders": False},
        }
        state = sync.StateStore.load(state_path, identity)
        client = sync.DriveClient(
            identity["panelUrl"], "project", "bucket", "test-key", timeout=10, retries=1
        )
        runner = sync.SyncRunner(
            client,
            state,
            sync.ScanResult((snapshot,), (), ()),
            single_threshold=threshold,
            requested_part_size=part_size,
            file_workers=1,
            part_workers=2,
            retries=1,
            finalize_timeout=3,
            preserve_empty_folders=False,
            reset_ambiguous=False,
            quiet=True,
        )
        return runner.run()

    def test_direct_upload_polls_and_second_run_verifies_without_put(self) -> None:
        server, thread = start_mock()
        try:
            with tempfile.TemporaryDirectory() as raw:
                path = Path(raw) / "file.unknown"
                path.write_bytes(b"binary\x00payload")
                snapshot = sync.snapshot_file(path, "single/file.unknown")
                state_path = Path(raw) / "state.json"
                first = self.run_runner(snapshot, server, state_path, threshold=1024, part_size=5 * 1024 * 1024)
                self.assertEqual(first["uploaded"], 1)
                puts = server.store["single_puts"]  # type: ignore[attr-defined]
                second = self.run_runner(snapshot, server, state_path, threshold=1024, part_size=5 * 1024 * 1024)
                self.assertEqual(second["skipped"], 1)
                self.assertEqual(server.store["single_puts"], puts)  # type: ignore[attr-defined]
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_multipart_upload_uses_all_parts_and_exact_etags(self) -> None:
        server, thread = start_mock()
        try:
            with tempfile.TemporaryDirectory() as raw:
                path = Path(raw) / "large.bin"
                original = bytes((index % 251 for index in range(11 * 1024 * 1024 + 17)))
                path.write_bytes(original)
                snapshot = sync.snapshot_file(path, "large/large.bin")
                state_path = Path(raw) / "state.json"
                result = self.run_runner(
                    snapshot,
                    server,
                    state_path,
                    threshold=1,
                    part_size=5 * 1024 * 1024,
                )
                self.assertEqual(result["uploaded"], 1)
                self.assertEqual(server.store["objects"][snapshot.key]["bytes"], original)  # type: ignore[attr-defined]
                self.assertEqual(
                    [part["partNumber"] for part in server.store["complete_parts"]],  # type: ignore[attr-defined]
                    [1, 2, 3],
                )
                self.assertEqual(
                    [part["etag"] for part in server.store["complete_parts"]],  # type: ignore[attr-defined]
                    ['"part-1"', '"part-2"', '"part-3"'],
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_lock_check_unavailable_is_not_marked_as_ambiguous_start(self) -> None:
        server, thread = start_mock()
        server.store["lock_check_unavailable"] = True  # type: ignore[attr-defined]
        try:
            with tempfile.TemporaryDirectory() as raw:
                path = Path(raw) / "large.bin"
                path.write_bytes(b"multipart data")
                snapshot = sync.snapshot_file(path, "large/large.bin")
                state_path = Path(raw) / "state.json"
                identity = {
                    "panelUrl": f"http://127.0.0.1:{server.server_port}",
                    "projectId": "project",
                    "bucket": "bucket",
                    "prefix": "",
                    "source": {
                        "files": [str(snapshot.path)],
                        "folder": None,
                        "includeRoot": True,
                        "preserveEmptyFolders": False,
                    },
                }
                state = sync.StateStore.load(state_path, identity)
                client = sync.DriveClient(
                    identity["panelUrl"], "project", "bucket", "test-key", timeout=10, retries=1
                )
                runner = sync.SyncRunner(
                    client,
                    state,
                    sync.ScanResult((snapshot,), (), ()),
                    single_threshold=1,
                    requested_part_size=5 * 1024 * 1024,
                    file_workers=1,
                    part_workers=1,
                    retries=1,
                    finalize_timeout=3,
                    preserve_empty_folders=False,
                    reset_ambiguous=False,
                    quiet=True,
                )
                result = runner.run()
                self.assertEqual(result["failed"], 1)
                record = state.get_file(snapshot.key)
                self.assertIsNotNone(record)
                self.assertEqual(record["status"], "failed")
                self.assertNotEqual(record["status"], "ambiguous_multipart_start")
                self.assertIn("LOCK_CHECK_UNAVAILABLE", record["lastError"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
