#!/usr/bin/env bash
# Generate fresh dev identities for additional worker nodes by spinning up
# throwaway bee containers, letting bee write its own keys, and copying them
# out. Prints each new node's Ethereum address to stdout so they can be added
# to blockchain/deploy/script/Deploy.s.sol's _beeNodes() array.
#
# Usage:
#   ./scripts/generate-identities.sh <start_n> <end_n>
#   ./scripts/generate-identities.sh 5 8     # generates worker-5..worker-8
#
# After running:
#   1. Update _beeNodes() in Deploy.s.sol with the printed EOAs
#   2. ./scripts/redeploy-contracts.sh   # bake them into state.anvil.json
#   3. docker compose build              # rebuild per-role bee images
#
# Linux/macOS only — Windows users should clone the repo into WSL or run
# this on a Linux/macOS machine; identities only need generating once at
# bake time.
set -euo pipefail
cd "$(dirname "$0")/.."

START="${1:?usage: $0 <start_n> <end_n>}"
END="${2:?usage: $0 <start_n> <end_n>}"
BEE_VERSION="${BEE_VERSION:-2.8.0}"
PASSWORD="password"

echo
echo "Generating worker-$START..worker-$END identities (bee v$BEE_VERSION)..."
echo

declare -a NEW_ADDRS

for N in $(seq "$START" "$END"); do
  DEST="bee/data/worker-$N"
  if [ -d "$DEST" ]; then
    echo "ERROR: $DEST already exists; refusing to overwrite" >&2
    exit 1
  fi

  TMP=$(mktemp -d)
  CNAME="bee-genid-worker-$N-$$"

  # Boot bee with an unreachable RPC; keys are written before chain init
  # fails. swap is disabled so we don't need a working factory either.
  docker run -d --name "$CNAME" \
    -v "$TMP:/home/bee/.bee" \
    -e BEE_PASSWORD="$PASSWORD" \
    -e BEE_API_ADDR=0.0.0.0:1633 \
    -e BEE_MAINNET=false \
    -e BEE_NETWORK_ID=4020 \
    -e BEE_SWAP_ENABLE=false \
    -e BEE_FULL_NODE=false \
    -e BEE_BLOCKCHAIN_RPC_ENDPOINT=http://127.0.0.1:1 \
    "ethersphere/bee:$BEE_VERSION" start >/dev/null

  # Wait for swarm.key to land (it's the canonical "keys ready" signal).
  ADDR=""
  for i in $(seq 1 30); do
    if [ -f "$TMP/keys/swarm.key" ]; then
      # EOA appears in logs as: "msg"="using ethereum address" "address"="0x..."
      ADDR=$(docker logs "$CNAME" 2>&1 \
        | grep -oE '"msg"="using ethereum address" "address"="0x[a-fA-F0-9]+"' \
        | grep -oE '0x[a-fA-F0-9]+' \
        | head -1 || true)
      [ -n "$ADDR" ] && break
    fi
    sleep 1
  done

  docker rm -f "$CNAME" >/dev/null

  if [ -z "$ADDR" ] || [ ! -f "$TMP/keys/swarm.key" ]; then
    echo "ERROR: bee didn't produce keys + EOA for worker-$N within 30s" >&2
    rm -rf "$TMP"
    exit 1
  fi

  mkdir -p "$DEST/keys"
  # Copy only the key files (not statestore/localstore that bee may also leave behind).
  cp "$TMP/keys/"*.key "$DEST/keys/"
  rm -rf "$TMP"

  # Mirror the per-identity .gitignore that the existing workers carry, so
  # runtime artifacts in this directory don't get accidentally committed if
  # someone bind-mounts here.
  cat > "$DEST/.gitignore" <<'EOF'
statestore
localstore
stamperstore
kademlia-metrics
EOF

  echo "worker-$N: $ADDR"
  NEW_ADDRS+=("$ADDR // worker-$N")
done

echo
echo "================================================================="
echo "Add these entries to _beeNodes() in"
echo "  blockchain/deploy/script/Deploy.s.sol"
echo
i=0
for entry in "${NEW_ADDRS[@]}"; do
  printf '        nodes[?] = %s;\n' "$entry"
  i=$((i + 1))
done
echo
echo "Then:"
echo "  ./scripts/redeploy-contracts.sh"
echo "  docker compose build"
echo "================================================================="
