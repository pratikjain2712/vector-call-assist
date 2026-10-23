#!/usr/bin/env bash
# Runs every SQL test (or the ones named) on a fresh scratch database.
# Usage: supabase/tests/run.sh [db_name] [test_file ...]
# Needs a local Postgres you can reach as the current user (PGHOST/PGUSER may be set).
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${1:-vector_test}"; shift || true
TESTS=("$@"); [ ${#TESTS[@]} -eq 0 ] && TESTS=(supabase/tests/*_test.sql)
fail=0
for t in "${TESTS[@]}"; do
  dropdb --if-exists "$DB"; createdb "$DB"
  psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/stub_auth.sql >/dev/null
  for m in supabase/migrations/*.sql; do
    psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$m" >/dev/null || { echo "MIGRATION FAILED: $m"; exit 1; }
  done
  out=$(psql -X -A -t -F '|' -d "$DB" -f "$t" 2>&1 || true)
  # Two styles: a final "passed|failed" count line, or a raise-exception test that ends with "... passed/done".
  last=$(printf '%s\n' "$out" | grep -E '^[0-9]+\|[0-9]+$' | tail -1 || true)
  errs=$(printf '%s\n' "$out" | grep -E '\|FAIL\||ERROR:' || true)
  if [ -n "$last" ]; then
    echo "$(basename "$t"): passed ${last%|*}, failed ${last#*|}"
    [ "${last#*|}" = "0" ] || errs="${errs:-count line shows failures}"
  else
    echo "$(basename "$t"): $(printf '%s\n' "$out" | grep -v '^$' | tail -1)"
  fi
  if [ -n "$errs" ]; then fail=1; printf '%s\n' "$errs" | head -20; fi
done
dropdb --if-exists "$DB"
exit $fail
