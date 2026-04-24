#!/usr/bin/env bash
# Bring up the worker profile with BEE_BOOTNODE resolved from the queen's /addresses
# endpoint. We construct /dns4/queen/tcp/1634/p2p/<peer-id> so the multiaddr is stable
# across queen container recreates (IP might change; peer ID won't — it's derived from
# the baked libp2p key).
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose.yml)

# Ensure queen is up.
if ! "${COMPOSE[@]}" ps --services --filter status=running | grep -qx queen; then
  echo "queen is not running — starting base stack first..."
  "${COMPOSE[@]}" up -d
fi

if [ -z "${QUEEN_BOOTNODE:-}" ]; then
  echo "Resolving queen peer id from http://127.0.0.1:1633/addresses ..."
  PEER_ID=""
  for i in $(seq 1 24); do
    PEER_ID=$(curl -fsS http://127.0.0.1:1633/addresses 2>/dev/null \
      | python3 -c 'import json,sys,re
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in d.get("underlay", []):
    m = re.search(r"/p2p/([A-Za-z0-9]+)$", a)
    if m:
        print(m.group(1))
        break' \
      || true)
    if [ -n "$PEER_ID" ]; then break; fi
    echo "  waiting for queen API... ($i/24)"
    sleep 5
  done

  if [ -z "$PEER_ID" ]; then
    echo "ERROR: could not resolve queen peer id; is the queen container healthy?" >&2
    exit 1
  fi

  export QUEEN_BOOTNODE="/dns4/queen/tcp/1634/p2p/$PEER_ID"
fi

echo "Using QUEEN_BOOTNODE=$QUEEN_BOOTNODE"
exec "${COMPOSE[@]}" --profile workers up -d
