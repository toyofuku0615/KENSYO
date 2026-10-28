#!/bin/sh
# Run ONLY against a disposable empty PostgreSQL database. The bootstrap models
# Supabase's auth.uid() and roles; the actual policies run as authenticated.
set -eu
[ "${KENSHO_TEST_DATABASE:-}" = "1" ] || { echo 'Set KENSHO_TEST_DATABASE=1 for a disposable empty test database.' >&2; exit 1; }
: "${DATABASE_URL:?Set DATABASE_URL for a disposable empty PostgreSQL database}"
cd "$(dirname "$0")/.."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202610280001_initial.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202610280002_ai.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/claims.sql
