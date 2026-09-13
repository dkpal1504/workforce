#!/usr/bin/env bash
# Local development testing only: bring the SQLite dev database up.
#
# Runs the same provider-aware setup the README documents:
#   npm run db:setup  ->  build shared | prisma generate | schema push | seed
# With a file: URL the schema step is `prisma db push` against SQLite; with a
# PostgreSQL URL it is `prisma migrate deploy` (the production path). Nothing
# here touches the PostgreSQL migrations or the production deployment.
#
# Usage:  bash scripts/dev-sqlite-setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Database URLs"
python3 - <<'PY'
import re
for path in ("apps/api/.env", ".env"):
    try:
        text = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        print(f"    {path}: missing")
        continue
    if re.search(r'^DATABASE_URL="?file:', text, re.M):
        print(f"    {path}: SQLite  file:./dev.db")
    else:
        line = next((l for l in text.splitlines() if l.startswith("DATABASE_URL")), "DATABASE_URL=<unset>")
        print(f"    {path}: NOT SQLite -> {line}")
print('    (set DATABASE_URL="file:./dev.db" in both files for the SQLite dev path)')
PY

echo "==> npm run db:setup"
npm run db:setup

echo
echo "SQLite dev database ready: apps/api/prisma/dev.db"
echo "Terminal 1: npm run dev:api    Terminal 2: npm run dev:web    UI: http://localhost:5173"
