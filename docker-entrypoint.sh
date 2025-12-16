#!/usr/bin/env sh
set -eu

if [ -f "/app/.env" ]; then
  # Export variables from .env for the running process.
  # shellcheck disable=SC1091
  set -a
  . "/app/.env"
  set +a
fi

exec "$@"
