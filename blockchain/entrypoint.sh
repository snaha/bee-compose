#!/bin/sh
# Seed the persistent state file from the baked snapshot on first boot, then
# hand off to anvil. The CMD passes `--state /data/state.gnosis.json`, which
# makes anvil both load from and dump to that path — so chain state survives
# container restarts via the named volume mounted at /data.
#
# The runtime file is named after the snapshot on purpose. A volume seeded by
# an older release holds a chain built from different contracts at different
# addresses, and seeding "only if absent" would keep serving it: the nodes
# would come up pointed at addresses holding no code, with nothing reporting a
# fault. Naming the file after its snapshot makes such a volume seed afresh.
#
# The snapshot is hybrid — mainnet's BZZ token and SushiSwap pools, with the
# Swarm contracts deployed from source onto their mainnet addresses — so
# everything the cluster needs is in it and no internet is required. Nodes are
# pointed at those same mainnet addresses in compose.yml to match.
set -e

STATE_FILE="/data/state.gnosis.json"

if [ ! -f "$STATE_FILE" ]; then
    cp /state.gnosis.json "$STATE_FILE"
fi

exec anvil "$@"
