#!/usr/bin/env bash
#
# scripts/backup.sh — operational backup of the OP Sprint Planner database
# (Increment 27, CONTRACTS §8).
#
#   DATABASE_URL=postgres://dev@localhost:5432/osp \
#     scripts/backup.sh --db osp
#
# Produces `backups/<db>-YYYYmmdd-HHMMSS.dump` in PostgreSQL's custom format
# (`pg_dump -Fc`): compressed, and restorable selectively with `pg_restore`.
#
# WHY --db is mandatory even though DATABASE_URL already says which database:
# it forces the operator to state the target out loud, so a stale DATABASE_URL
# left over in a shell can never quietly back up (or, in restore.sh, overwrite)
# a database nobody meant to touch. The two must agree or the script stops.
#
# This is the *byte-exact* backup. The JSON export (GET /api/data/export) is the
# *portable* one. They complement each other — see README §Backup, restore &
# transfer for which to reach for when.
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: DATABASE_URL=... scripts/backup.sh --db <database-name> [options]

Options
  --db <name>        REQUIRED. Must match the database in DATABASE_URL.
  --out-dir <dir>    Where to write the dump (default: ./backups).
  --label <text>     Extra token in the filename, e.g. --label pre-migration.
  -h, --help         This text.

Example
  DATABASE_URL=postgres://dev@localhost:5432/osp \
    scripts/backup.sh --db osp --label pre-increment-27
EOF
}

die() { printf '\n\033[31m✖ %s\033[0m\n\n' "$*" >&2; exit 2; }

# Database name out of a postgres:// URL: drop any ?query, take the last path segment.
url_db() { local u="${1%%\?*}"; printf '%s' "${u##*/}"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME=""
OUT_DIR="$REPO_ROOT/backups"
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)      DB_NAME="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --label)   LABEL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)         die "Unknown argument \"$1\". Try --help." ;;
  esac
done

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set. There is no default (CONTRACTS §1)."
[[ -n "$DB_NAME" ]] || die "--db <database-name> is required, and must match DATABASE_URL. Try --help."

URL_DB="$(url_db "$DATABASE_URL")"
[[ -n "$URL_DB" ]] || die "DATABASE_URL has no database name in its path: $DATABASE_URL"

if [[ "$URL_DB" != "$DB_NAME" ]]; then
  die "Refusing to run: you asked for \"$DB_NAME\" but DATABASE_URL points at \"$URL_DB\".
  Fix one of them so they agree. (This guard exists so a leftover DATABASE_URL
  in your shell can never silently redirect a backup at the wrong database.)"
fi

command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found on PATH."

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SUFFIX=""
[[ -n "$LABEL" ]] && SUFFIX="-${LABEL//[^A-Za-z0-9._-]/_}"
OUT_FILE="$OUT_DIR/${DB_NAME}-${STAMP}${SUFFIX}.dump"

printf '→ pg_dump -Fc %s → %s\n' "$DB_NAME" "$OUT_FILE"

# --no-owner / --no-privileges keep the dump portable: it restores cleanly under
# whatever role the target server uses, instead of demanding the source's.
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file="$OUT_FILE" "$DATABASE_URL"

# A dump that pg_restore cannot even list is not a backup. Catch it now, while
# the source database still exists, not during an emergency six months from now.
pg_restore --list "$OUT_FILE" >/dev/null || die "The dump was written but pg_restore cannot read it: $OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1 | tr -d ' ')"
TABLES="$(pg_restore --list "$OUT_FILE" | grep -c 'TABLE DATA' || true)"

printf '\n\033[32m✔ backup OK\033[0m\n'
printf '  file   : %s\n' "$OUT_FILE"
printf '  size   : %s\n' "$SIZE"
printf '  tables : %s with data\n' "$TABLES"
printf '\n  restore with:\n    DATABASE_URL=%s scripts/restore.sh --db %s --file %s --clean\n\n' \
  "$DATABASE_URL" "$DB_NAME" "$OUT_FILE"
