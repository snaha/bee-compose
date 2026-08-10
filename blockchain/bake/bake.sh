#!/usr/bin/env bash
# Re-bake blockchain/state.gnosis.json, the chain this cluster runs on.
#
# NEEDS INTERNET (it forks Gnosis mainnet and downloads solc); replaying the
# result does not. From the repo root:
#
#   pnpm install --ignore-workspace   # once — see CLAUDE.md
#   pnpm bake
#
# Three stages, and the split is the whole design (blockchain/HYBRID-CHAIN.md):
#
#   1. warm the DEX on a fork, touching nothing else, and dump. The Swarm
#      contracts stay untouched, so they are absent from the dump and their
#      addresses reload empty.
#   2. load that dump into a PLAIN anvil and deploy the Swarm contracts into
#      those empty addresses. Their batch tree starts empty, which is what
#      makes createBatch work indefinitely instead of for a handful of calls.
#   3. splice back the contracts a dump drops, and assert the result is whole.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

UPSTREAM="${GNOSIS_RPC_URL:-https://rpc.gnosischain.com}"
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:stable}"
OUT="$ROOT/blockchain/state.gnosis.json"
DEPLOY_DIR="$ROOT/blockchain/deploy"

FORK_PORT=18545
DEPLOY_PORT=18546
FORK_NAME="bee-compose-bake-fork-$$"
DEPLOY_NAME="bee-compose-bake-deploy-$$"
WORK="$(mktemp -d)"

cleanup() {
  local status=$?
  docker rm -f "$FORK_NAME" "$DEPLOY_NAME" >/dev/null 2>&1 || true
  # Keep the intermediate dumps when a stage failed — stage 1 costs internet
  # and several minutes, and they are the only thing left to debug from.
  if [ "$status" -eq 0 ]; then
    rm -rf "$WORK" || true
  else
    echo "==> bake failed; its intermediate state is in $WORK" >&2
  fi
}
trap cleanup EXIT

wait_for_rpc() { # wait_for_rpc <port>
  for _ in $(seq 1 60); do
    if curl -sf -m 2 -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "http://127.0.0.1:$1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "anvil on :$1 never answered" >&2
  exit 1
}

wait_for_dump() { # wait_for_dump <path>
  for _ in $(seq 1 60); do
    [ -s "$1" ] && return 0
    sleep 1
  done
  echo "anvil wrote no state dump to $1" >&2
  exit 1
}

echo "==> checking out the contract submodules"
# Non-recursive on purpose: recursing into OpenZeppelin pulls in nested
# forge-std / halmos clones whose presence trips foundry's auto-detected
# remappings, which remappings.txt overrides explicitly.
git -C "$ROOT" submodule update --init \
  blockchain/deploy/lib/openzeppelin-contracts \
  blockchain/deploy/lib/storage-incentives

echo "==> compiling the Swarm contracts"
docker run --rm -v "$DEPLOY_DIR:/work" -w /work --entrypoint forge "$FOUNDRY_IMAGE" build

echo "==> [1/3] forking $UPSTREAM"
docker run -d --rm --name "$FORK_NAME" -p "127.0.0.1:$FORK_PORT:8545" -v "$WORK:/state" \
  --entrypoint anvil "$FOUNDRY_IMAGE" \
  --fork-url "$UPSTREAM" --host 0.0.0.0 --port 8545 \
  --dump-state /state/dex.json >/dev/null
wait_for_rpc "$FORK_PORT"

FORK_RPC_URL="http://127.0.0.1:$FORK_PORT" pnpm exec tsx blockchain/bake/warm-dex.ts

echo "==> stopping the fork so it writes its dump"
docker stop "$FORK_NAME" >/dev/null
wait_for_dump "$WORK/dex.json"

echo "==> [2/3] deploying the Swarm contracts onto the DEX-only snapshot"
docker run -d --rm --name "$DEPLOY_NAME" -p "127.0.0.1:$DEPLOY_PORT:8545" -v "$WORK:/state" \
  --entrypoint anvil "$FOUNDRY_IMAGE" \
  --chain-id 100 --host 0.0.0.0 --port 8545 \
  --load-state /state/dex.json --dump-state /state/hybrid.json >/dev/null
wait_for_rpc "$DEPLOY_PORT"

DEPLOY_RPC_URL="http://127.0.0.1:$DEPLOY_PORT" \
  pnpm exec tsx blockchain/bake/deploy-swarm.ts "$WORK/deploy-report.json"

docker stop "$DEPLOY_NAME" >/dev/null
wait_for_dump "$WORK/hybrid.json"

echo "==> [3/3] splicing read-only contracts back in and checking the result"
GNOSIS_RPC_URL="$UPSTREAM" pnpm exec tsx blockchain/bake/finalise.ts \
  "$WORK/hybrid.json" --report "$WORK/deploy-report.json"

mv "$WORK/hybrid.json" "$OUT"
echo
echo "==> wrote $OUT"
echo "    apply it with: bee-compose stop --rm && bee-compose start"
