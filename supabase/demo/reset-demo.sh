#!/usr/bin/env bash
# Loads (or reloads) the demo institute in one go: the 8 demo logins, then the demo data.
# Needs Node 18+ (npm install done in the repo) and psql. Steps and where to find the values: docs/demo.md.
#
#   export SUPABASE_URL=https://<ref>.supabase.co
#   export SUPABASE_SERVICE_ROLE_KEY=...        # Project settings > API keys (secret / service_role)
#   export SUPABASE_DB_URL='postgresql://...'   # Connect > Session pooler connection string, with the DB password
#   export DEMO_PASSWORD='...'                  # at least 10 characters; every demo login uses it
#   supabase/demo/reset-demo.sh
#
# Run it on the morning of the demo, ideally 15–30 minutes before, so "Today" is today.
set -euo pipefail
cd "$(dirname "$0")/../.."

missing=()
for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL DEMO_PASSWORD; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "reset-demo: set ${missing[*]} first (docs/demo.md)." >&2
  exit 1
fi
command -v node >/dev/null || { echo "reset-demo: Node.js is needed." >&2; exit 1; }
command -v psql >/dev/null || { echo "reset-demo: psql is needed (PostgreSQL client)." >&2; exit 1; }

echo "1/2 Demo logins"
node supabase/demo/create-demo-users.mjs

# The terms version and text hash the caller page checks, so the demo logins are not asked to accept again.
terms=$(node -e '
  const w = {}; new Function("window", require("fs").readFileSync("web/js/terms.js", "utf8"))(w);
  const h = require("crypto").createHash("sha256").update(String(w.TERMS.text), "utf8").digest("hex");
  process.stdout.write(w.TERMS.version + " " + h);')

echo "2/2 Demo data (takes up to a minute)"
psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 \
  -v terms_version="${terms%% *}" -v terms_hash="${terms##* }" \
  -f supabase/demo/demo_seed.sql
echo "Done. Sign in at admin.html (owner or manager) and app.html (callers) with DEMO_PASSWORD."
