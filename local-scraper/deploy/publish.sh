#!/usr/bin/env bash
# Publica les dades noves al repositori remot (pensat per executar-lo un cop al dia).
#   0 3 * * * cd /Users/marc/Documents/parking_terrassa && deploy/publish.sh >> logs/publish.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
git add data/
if git diff --cached --quiet; then
  echo "$(date -u +%FT%TZ) res a publicar"
  exit 0
fi
git commit -q -m "data: captures fins a $(date -u +%FT%TZ)"
git push -q
echo "$(date -u +%FT%TZ) publicat"
