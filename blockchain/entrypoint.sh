#!/bin/sh
# Seed the persistent state file from the baked snapshot on first boot, then
# hand off to anvil. The CMD passes `--state /data/state.anvil.json`, which
# makes anvil both load from and dump to that path — so chain state survives
# container restarts via the named volume mounted at /data.
set -e

STATE_FILE="/data/state.anvil.json"

if [ ! -f "$STATE_FILE" ]; then
    cp /state.anvil.json "$STATE_FILE"
fi

exec anvil "$@"
