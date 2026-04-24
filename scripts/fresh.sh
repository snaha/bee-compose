#!/usr/bin/env bash
# Tear down the stack and rebuild from a clean slate:
#   - remove all containers, volumes, and orphaned services
#   - pull the latest upstream blockchain image
#   - rebuild bee images against the latest upstream ethersphere/bee
#   - bring the queen back up (workers stay opt-in behind the `workers` profile)
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose.yml)

echo "== down (all profiles) =="
"${COMPOSE[@]}" --profile workers down -v --remove-orphans || true

echo "== pull external images =="
"${COMPOSE[@]}" pull blockchain

echo "== rebuild bee images (--pull refreshes base) =="
"${COMPOSE[@]}" --profile workers build --pull

echo "== up (queen only; use scripts/workers-up.sh to add workers) =="
"${COMPOSE[@]}" up -d
