# syntax=docker/dockerfile:1.7
# Gnosis-backed dev chain for bee-compose.
#
# state.gnosis.json is a dump of Gnosis mainnet taken from a forked anvil, so
# this chain carries the REAL contracts the Swarm ecosystem runs on — the
# PostageStamp at 0x45a1…, the BZZ token, and the SushiSwap pools postage is
# bought through — with no internet required. It also carries the 9 Bee node
# EOAs pre-funded with xDAI for gas.
#
# A dump only keeps accounts something WROTE to, so contracts that are merely
# read (the SushiSwap quoter, the price oracle, staking, redistribution) are
# spliced in when the snapshot is baked. Re-baking needs internet: fork
# mainnet, exercise every path this chain must serve, splice, dump.
#
# Runtime state is kept on a named volume mounted at /data; the entrypoint
# copies the baked snapshot into the volume on first boot and anvil's
# `--state` loads/dumps from that path so chain state survives restarts.
ARG FOUNDRY_VERSION=stable
FROM ghcr.io/foundry-rs/foundry:${FOUNDRY_VERSION}

COPY --chown=foundry:foundry state.gnosis.json /state.gnosis.json
COPY --chown=foundry:foundry --chmod=0755 entrypoint.sh /entrypoint.sh

USER root
RUN mkdir -p /data && chown foundry:foundry /data
USER foundry

EXPOSE 9545
ENTRYPOINT ["/entrypoint.sh"]
# --chain-id comes from the entrypoint (CHAIN_ID, default 100).
CMD ["--block-time", "5", \
     "--host", "0.0.0.0", \
     "--port", "9545", \
     "--state", "/data/state.anvil.json", \
     "--state-interval", "30"]
