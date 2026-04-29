#!/usr/bin/env bash
# Purchase a postage stamp on the queen. Defaults give ~29h of upload headroom on
# this 5s-block chain.
#
# Math: the on-chain effective price is 24000 (price/block/chunk) — that's
# PriceOracle's minimumPriceUpscaled floor; setPrice silently clamps anything
# lower, and Deploy.s.sol's INITIAL_PRICE is pinned to 24000 to match. Bee
# enforces a 17280-block minimum validity (24h), so the minimum valid amount is
# strictly greater than 24000 * 17280 = 414_720_000. The 500_000_000 default
# leaves ~21% headroom for a small price bump.
#
# Override:
#   buy-stamp.sh <amount> <depth>
#   BEE_API=http://127.0.0.1:11633 buy-stamp.sh   # target a worker instead of the queen
set -euo pipefail

AMOUNT="${1:-500000000}"
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
