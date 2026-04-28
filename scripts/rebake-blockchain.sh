#!/usr/bin/env bash
# Regenerate blockchain/state.anvil.json from the upstream fdp-play-blockchain
# image.
#
# How it works
# ------------
# 1. Boot `fairdatasociety/fdp-play-blockchain:$UPSTREAM_TAG` and wait for it.
# 2. Walk every block, pull each transaction's raw signed bytes.
# 3. Boot a scratch Anvil (chain-id 4020, automine) and seed genesis balances.
# 4. Replay the raw txs — anvil mines them into blocks, producing exact same
#    contract addresses and storage as the upstream chain. This sidesteps state
#    trie iteration (debug_dumpBlock is unusable on this chain — head-state
#    repair mode leaves it empty) and storage-slot preimage issues.
# 5. Post-correct balances + nonces for every known address so gas-rounding
#    differences vanish and the snapshot mirrors upstream exactly.
# 6. Call `anvil_dumpState`, gunzip, write plain-JSON to blockchain/state.anvil.json.
#
# Run this when bumping UPSTREAM_TAG. Commit the resulting state file.
#
# Runtime image uses `anvil --load-state /state.anvil.json`; there is no geth
# at runtime.

set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM_TAG="${UPSTREAM_TAG:-2.2.0}"
UPSTREAM_IMAGE="fairdatasociety/fdp-play-blockchain:${UPSTREAM_TAG}"
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:stable}"

GETH_NAME="rebake-geth-$$"
ANVIL_NAME="rebake-anvil-$$"
GETH_PORT=19545
ANVIL_PORT=18545
OUT="blockchain/state.anvil.json"

cleanup() { docker rm -f "$GETH_NAME" "$ANVIL_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== pulling images =="
docker pull "$UPSTREAM_IMAGE" >/dev/null
docker pull "$FOUNDRY_IMAGE" >/dev/null

echo "== booting upstream geth ($UPSTREAM_IMAGE) =="
docker run -d --name "$GETH_NAME" \
  -p "127.0.0.1:${GETH_PORT}:9545" \
  "$UPSTREAM_IMAGE" \
  --allow-insecure-unlock \
  --unlock=0xCEeE442a149784faa65C35e328CCd64d874F9a02 \
  --password=/root/password \
  --mine \
  --miner.etherbase=0xCEeE442a149784faa65C35e328CCd64d874F9a02 \
  --http --http.api=debug,web3,eth,txpool,net,personal \
  '--http.corsdomain=*' --http.port=9545 --http.addr=0.0.0.0 '--http.vhosts=*' \
  --maxpeers=0 --networkid=4020 \
  '--authrpc.vhosts=*' --authrpc.addr=0.0.0.0 >/dev/null

for i in $(seq 1 60); do
  if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    "http://127.0.0.1:${GETH_PORT}" 2>/dev/null | grep -q '"result":"0x[1-9a-f]'; then
    break
  fi
  [ "$i" = "60" ] && { echo "geth didn't come up" >&2; exit 1; }
  sleep 1
done

# extract genesis.json (we need the pre-funded EOA balances)
docker cp "$GETH_NAME:/root/genesis.json" "/tmp/${GETH_NAME}-genesis.json"

echo "== booting scratch anvil (automine) =="
docker run -d --name "$ANVIL_NAME" \
  -p "127.0.0.1:${ANVIL_PORT}:8545" \
  --entrypoint anvil "$FOUNDRY_IMAGE" \
  --chain-id 4020 --host 0.0.0.0 --port 8545 >/dev/null

for i in $(seq 1 30); do
  if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "http://127.0.0.1:${ANVIL_PORT}" 2>/dev/null | grep -q '"result"'; then
    break
  fi
  [ "$i" = "30" ] && { echo "anvil didn't come up" >&2; exit 1; }
  sleep 1
done

echo "== replaying upstream state into anvil =="
GETH_URL="http://127.0.0.1:${GETH_PORT}" \
ANVIL_URL="http://127.0.0.1:${ANVIL_PORT}" \
GENESIS_PATH="/tmp/${GETH_NAME}-genesis.json" \
OUT_PATH="$OUT" \
python3 scripts/rebake-replay.py

rm -f "/tmp/${GETH_NAME}-genesis.json"

echo "== done =="
ls -lh "$OUT"
