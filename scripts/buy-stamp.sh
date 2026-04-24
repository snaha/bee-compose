#!/usr/bin/env bash
# Purchase a postage stamp on the queen. Defaults give ~24h of upload headroom on
# the fdp-play chain (5s blocks). Override via: buy-stamp.sh <amount> <depth>.
set -euo pipefail

AMOUNT="${1:-414720000}"
DEPTH="${2:-20}"
API="${BEE_API:-http://127.0.0.1:1633}"

echo "POST $API/stamps/$AMOUNT/$DEPTH"
RESP=$(curl -fsS -X POST "$API/stamps/$AMOUNT/$DEPTH")
echo "$RESP"

BATCH_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("batchID",""))' 2>/dev/null || true)
if [ -z "$BATCH_ID" ]; then
  echo "ERROR: no batchID in response" >&2
  exit 1
fi

echo "Waiting 15s for on-chain settlement..."
sleep 15
echo "Stamp ready: $BATCH_ID"
