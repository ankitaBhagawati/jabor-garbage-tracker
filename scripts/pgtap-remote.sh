#!/usr/bin/env bash
# Runs supabase/tests/database/*.sql against a remote database with psql (no pg_prove needed).
# Every test file wraps itself in begin ... rollback, so nothing is left behind.
# Usage: scripts/pgtap-remote.sh "$STAGING_DB_URL"
set -euo pipefail
db_url="${1:?pass the database URL}"
case "$db_url" in *wukftoblpeybortcnkuw*) echo "Refusing to run tests against production."; exit 1;; esac
status=0
for f in supabase/tests/database/*.sql; do
  out=$(psql "$db_url" -X -At -v ON_ERROR_STOP=1 -f "$f" 2>&1) || { echo "$f: psql error"; echo "$out" | grep -E 'ERROR' | head -3; status=1; continue; }
  planned=$(echo "$out" | grep -oE '^1\.\.[0-9]+' | cut -d. -f3)
  passed=$(echo "$out" | grep -cE '^ok ' || true)
  failed=$(echo "$out" | grep -E '^not ok ' || true)
  echo "$f: $passed/$planned passed"
  if [ -n "$failed" ] || [ "$passed" != "$planned" ]; then echo "$failed"; status=1; fi
done
exit $status
