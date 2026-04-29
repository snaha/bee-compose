#!/usr/bin/env bash
# Tear down the stack and rebuild from a clean slate:
#   - remove all containers, volumes, and orphaned services
#   - rebuild bee + blockchain images against the latest upstream bases
#     (ethersphere/bee, ghcr.io/foundry-rs/foundry)
#   - bring the queen back up (workers stay opt-in behind the `workers` profile)
#
# This does NOT regenerate blockchain/state.anvil.json — that snapshot is the
# committed output of deploying the Swarm contracts from source. To regenerate
# (e.g. after bumping a contract submodule), run scripts/redeploy-contracts.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose.yml)

echo "== down (all profiles) =="
"${COMPOSE[@]}" --profile workers down -v --remove-orphans || true

echo "== rebuild all images (--pull refreshes bases) =="
"${COMPOSE[@]}" --profile workers build --pull

echo "== up (queen + blockchain; use scripts/workers-up.sh to add workers) =="
"${COMPOSE[@]}" up -d
