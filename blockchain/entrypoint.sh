#!/bin/sh
# Seed the persistent state file from the baked snapshot on first boot, then
# hand off to anvil. The CMD passes `--state /data/state.anvil.json`, which
# makes anvil both load from and dump to that path — so chain state survives
# container restarts via the named volume mounted at /data.
#
# The snapshot is hybrid — mainnet's BZZ token and SushiSwap pools, with the
# Swarm contracts deployed from source onto their mainnet addresses — so
# everything the cluster needs is in it and no internet is required. Nodes are
# pointed at those same mainnet addresses in compose.yml to match.
set -e

STATE_FILE="/data/state.anvil.json"

if [ ! -f "$STATE_FILE" ]; then
    cp /state.gnosis.json "$STATE_FILE"
fi

exec anvil --chain-id "${CHAIN_ID:-100}" "$@"
