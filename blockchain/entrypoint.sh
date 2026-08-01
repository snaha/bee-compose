#!/bin/sh
# Seed the persistent state file from the baked snapshot on first boot, then
# hand off to anvil. The CMD passes `--state /data/state.anvil.json`, which
# makes anvil both load from and dump to that path — so chain state survives
# container restarts via the named volume mounted at /data.
#
# CHAIN_PROFILE picks which snapshot seeds it:
#   local  (default) — Swarm contracts deployed from source onto chain 4020
#   gnosis           — a dump of Gnosis mainnet, so the REAL PostageStamp, BZZ
#                      and SushiSwap pools are present on chain 100 with no
#                      internet. Nodes must then be pointed at the mainnet
#                      contract addresses (see compose.yml's gnosis profile).
set -e

CHAIN_PROFILE="${CHAIN_PROFILE:-local}"
CHAIN_ID="${CHAIN_ID:-4020}"
STATE_FILE="/data/state.anvil.json"

case "$CHAIN_PROFILE" in
    local)  SEED="/state.anvil.json" ;;
    gnosis) SEED="/state.gnosis.json" ;;
    *)      echo "unknown CHAIN_PROFILE: $CHAIN_PROFILE (want local|gnosis)" >&2; exit 1 ;;
esac

if [ ! -f "$STATE_FILE" ]; then
    cp "$SEED" "$STATE_FILE"
fi

exec anvil --chain-id "$CHAIN_ID" "$@"
