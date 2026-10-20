#!/usr/bin/env bash
#
# Thin wrapper around scripts/migrate-sqlite-to-pg.ts.
#
# The TypeScript is run through @osp/api's `tsx` (the only workspace package
# that already depends on it) so that `scripts/` needs no package.json, no
# node_modules and no place in pnpm-workspace.yaml. The script imports @osp/db
# by relative path for the same reason.
#
#   DATABASE_URL=postgres://dev@localhost:5432/osp_test_1 \
#     scripts/migrate-sqlite-to-pg.sh --sqlite apps/api/osp.sqlite
#
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `pnpm --filter` runs with cwd=apps/api, so relative --sqlite paths would
# resolve against the wrong directory. Hand the real one through.
export OSP_INVOKE_CWD="$PWD"
exec pnpm --dir "$REPO_ROOT" --filter @osp/api exec \
  tsx "$REPO_ROOT/scripts/migrate-sqlite-to-pg.ts" "$@"
