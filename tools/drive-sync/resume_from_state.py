"""Resume drive_sync.py from a saved state without a huge command line.

The state file contains the original source selection. This helper rebuilds
the in-memory argument list so Windows does not have to carry hundreds of
--file arguments through its command-line length limit.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drive_sync


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python resume_from_state.py STATE_JSON [drive_sync options...]",
            file=sys.stderr,
        )
        return 2

    state_path = Path(sys.argv[1]).expanduser().resolve()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Unable to read resume state {state_path}: {exc}", file=sys.stderr)
        return 1

    if not isinstance(state, dict) or not isinstance(state.get("identity"), dict):
        print(f"Resume state has no valid identity: {state_path}", file=sys.stderr)
        return 1
    identity = state["identity"]
    source = identity.get("source")
    if not isinstance(source, dict):
        print(f"Resume state has no valid source selection: {state_path}", file=sys.stderr)
        return 1

    required = ("panelUrl", "projectId", "bucket")
    if any(not isinstance(identity.get(name), str) or not identity[name].strip() for name in required):
        print(f"Resume state is missing panel/project/bucket identity: {state_path}", file=sys.stderr)
        return 1

    args = [
        "--panel-url",
        identity["panelUrl"],
        "--project-id",
        identity["projectId"],
        "--bucket",
        identity["bucket"],
        "--state-file",
        str(state_path),
    ]
    prefix = identity.get("prefix")
    if isinstance(prefix, str) and prefix:
        args += ["--prefix", prefix]
    if source.get("includeRoot", True) is False:
        args.append("--contents-only")
    args.append(
        "--preserve-empty-folders"
        if source.get("preserveEmptyFolders", True)
        else "--no-preserve-empty-folders"
    )

    folder = source.get("folder")
    if isinstance(folder, str) and folder:
        args += ["--folder", folder]
    else:
        files = source.get("files")
        if not isinstance(files, list) or not all(isinstance(item, str) and item for item in files):
            print(f"Resume state has no valid file selection: {state_path}", file=sys.stderr)
            return 1
        for file_path in files:
            args += ["--file", file_path]

    # Forward transfer controls such as --no-verify-completed, --workers,
    # --part-workers, --retries, and --finalize-timeout. Configuration and
    # source arguments are intentionally taken from the state identity.
    args.extend(sys.argv[2:])
    return drive_sync.main(args)


if __name__ == "__main__":
    raise SystemExit(main())
