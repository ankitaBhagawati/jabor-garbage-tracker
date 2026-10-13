#!/usr/bin/env bash
# Runs supabase/tests/database/*.sql against a remote database with psql (no pg_prove needed).
# Every test file wraps itself in begin ... rollback, so nothing is left behind.
# Usage: scripts/pgtap-remote.sh [--verbose] "$STAGING_DB_URL"
#   A failing test prints its "not ok" line and pgTAP's diagnostics (the # lines: have / want). With --verbose, a
#   file that has a failure also prints its whole output.
set -euo pipefail
verbose=0
args=()
for a in "$@"; do
  if [ "$a" = "--verbose" ] || [ "$a" = "-v" ]; then verbose=1; else args+=("$a"); fi
done
db_url="${args[0]:?pass the database URL}"
case "$db_url" in *wukftoblpeybortcnkuw*) echo "Refusing to run tests against production."; exit 1;; esac
status=0
for f in supabase/tests/database/*.sql; do
  out=$(psql "$db_url" -X -At -v ON_ERROR_STOP=1 -f "$f" 2>&1) || { echo "$f: psql error"; echo "$out" | grep -E 'ERROR' | head -3; status=1; continue; }
  planned=$(echo "$out" | grep -oE '^1\.\.[0-9]+' | cut -d. -f3)
  passed=$(echo "$out" | grep -cE '^ok ' || true)
  failed=$(echo "$out" | grep -E '^not ok ' || true)
  echo "$f: $passed/$planned passed"
  if [ -n "$failed" ] || [ "$passed" != "$planned" ]; then
    echo "$failed"
    echo "$out" | grep -E '^# ' || true
    if [ "$verbose" = 1 ]; then echo "--- full output of $f ---"; echo "$out"; echo "--- end ---"; fi
    status=1
  fi
done
exit $status
