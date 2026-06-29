#!/usr/bin/env sh
# Run from repo root: ./scripts/open-advisor-dashboard.sh
# Or: sh scripts/open-advisor-dashboard.sh

cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "Starting advisor dashboard (browser should open)..."
exec node scripts/advisor-ui.mjs
