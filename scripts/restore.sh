#!/usr/bin/env bash
#
# scripts/restore.sh — restore a `scripts/backup.sh` dump (Increment 27, CONTRACTS §8).
#
#   DATABASE_URL=postgres://dev@localhost:5432/osp_test_1 \
#     scripts/restore.sh --db osp_test_1 --file backups/osp-20260810-094612.dump --clean
#
# ⚠️ This is the destructive half of the pair. Three guards stand in front of it:
#
#   1. --db is mandatory and must match DATABASE_URL, so a stale environment
#      variable can never redirect a restore at the wrong database.
#   2. Every database in OSP_FOREIGN_DATABASES (comma-separated; from the
#      environment or the untracked .env.local) is refused unconditionally —
#      those belong to unrelated projects sharing this Postgres instance, and
#      no OSP dump has any business being written into them.
#   3. --clean (drop-and-recreate every object) requires an interactive "yes",
#      or an explicit --yes when running unattended.
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: DATABASE_URL=... scripts/restore.sh --db <database-name> --file <dump> [options]

Options
  --db <name>     REQUIRED. Must match the database in DATABASE_URL.
  --file <path>   REQUIRED. A pg_dump custom-format (-Fc) file.
  --clean         Drop existing objects before restoring (--clean --if-exists).
                  Use this to restore over a populated database.
  --yes           Skip the interactive confirmation (for cron/CI).
  -h, --help      This text.

Note
  Without --clean, pg_restore loads into an EMPTY database. Restoring over
  populated tables without --clean produces duplicate-key errors, not a merge.
EOF
}

die() { printf '\n\033[31m✖ %s\033[0m\n\n' "$*" >&2; exit 2; }
url_db() { local u="${1%%\?*}"; printf '%s' "${u##*/}"; }

DB_NAME=""; DUMP_FILE=""; CLEAN=0; ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)      DB_NAME="${2:-}"; shift 2 ;;
    --file)    DUMP_FILE="${2:-}"; shift 2 ;;
    --clean)   CLEAN=1; shift ;;
    --yes)     ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         die "Unknown argument \"$1\". Try --help." ;;
  esac
done

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set. There is no default (CONTRACTS §1)."
[[ -n "$DB_NAME" ]]   || die "--db <database-name> is required, and must match DATABASE_URL. Try --help."
[[ -n "$DUMP_FILE" ]] || die "--file <dump> is required. Try --help."
[[ -f "$DUMP_FILE" ]] || die "No such dump file: $DUMP_FILE"

URL_DB="$(url_db "$DATABASE_URL")"
if [[ "$URL_DB" != "$DB_NAME" ]]; then
  die "Refusing to run: you asked for \"$DB_NAME\" but DATABASE_URL points at \"$URL_DB\"."
fi

FOREIGN_DBS="${OSP_FOREIGN_DATABASES:-}"
ENV_LOCAL="$(dirname "$0")/../.env.local"
if [[ -z "$FOREIGN_DBS" && -f "$ENV_LOCAL" ]]; then
  FOREIGN_DBS="$(sed -n 's/^OSP_FOREIGN_DATABASES=//p' "$ENV_LOCAL" | tr -d "\"'")"
fi
IFS=',' read -r -a FOREIGN_LIST <<< "$FOREIGN_DBS"
for foreign in "${FOREIGN_LIST[@]}"; do
  foreign="$(echo "$foreign" | tr -d '[:space:]')"
  if [[ -n "$foreign" && "$DB_NAME" == "$foreign" ]]; then
    die "Refusing to restore into \"$DB_NAME\" — it is listed in OSP_FOREIGN_DATABASES:
  it belongs to a different project sharing this PostgreSQL instance. No OSP dump belongs there."
  fi
done

command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found on PATH."
pg_restore --list "$DUMP_FILE" >/dev/null 2>&1 || die "Not a readable pg_dump custom-format archive: $DUMP_FILE"

printf '\n  target : %s\n' "$DB_NAME"
printf '  dump   : %s (%s)\n' "$DUMP_FILE" "$(du -h "$DUMP_FILE" | cut -f1 | tr -d ' ')"
printf '  mode   : %s\n\n' "$([[ $CLEAN -eq 1 ]] && echo 'CLEAN — existing objects will be DROPPED' || echo 'load into an empty database')"

if [[ $CLEAN -eq 1 && $ASSUME_YES -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    die "--clean drops every object in \"$DB_NAME\" and stdin is not a terminal.
  Re-run with --yes if you really mean it."
  fi
  read -r -p "Type the database name to confirm the DROP: " CONFIRM
  [[ "$CONFIRM" == "$DB_NAME" ]] || die "Confirmation did not match. Nothing was changed."
fi

RESTORE_ARGS=(--no-owner --no-privileges --dbname="$DATABASE_URL")
[[ $CLEAN -eq 1 ]] && RESTORE_ARGS+=(--clean --if-exists)

printf '→ pg_restore…\n'
# `--clean --if-exists` emits harmless NOTICEs for objects that do not exist yet;
# pg_restore reports those as "errors ignored" rather than failing, so we let a
# non-zero exit through only when nothing at all could be restored.
if ! pg_restore "${RESTORE_ARGS[@]}" "$DUMP_FILE"; then
  printf '\n\033[33m! pg_restore reported errors (often harmless with --clean on a fresh database).\033[0m\n'
  printf '  Verify below before trusting this restore.\n'
fi

printf '\n\033[32m✔ restore finished\033[0m — verifying:\n'
psql "$DATABASE_URL" -Atc "
  SELECT relname || ' = ' || n_live_tup
  FROM pg_stat_user_tables
  WHERE n_live_tup > 0
  ORDER BY relname;" | sed 's/^/    /'
printf '\n  (row estimates; run ANALYZE for exact counts)\n\n'
