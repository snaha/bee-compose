# syntax=docker/dockerfile:1.7
# Gnosis-backed dev chain for bee-compose.
#
# state.gnosis.json is a HYBRID snapshot, not a plain mainnet dump: the BZZ
# token, WXDAI and the SushiSwap router / quoter / BZZ pool are borrowed from a
# Gnosis mainnet fork — a BZZ market can only be borrowed — while the Swarm
# contracts (PostageStamp, PriceOracle, StakeRegistry, Redistribution) are
# deployed from source on top, onto their mainnet addresses. It also carries
# the 9 Bee node EOAs funded with xDAI for gas and BZZ for their own postage,
# and a dev faucet holding a BZZ float. No internet required at runtime.
#
# Re-baking does need internet, and runs in three stages: warm the DEX on a
# fork, deploy the Swarm contracts into the addresses that leaves empty, then
# splice back the contracts a dump drops (the SushiSwap quoter, which is only
# ever read). The staging is the whole design — blockchain/HYBRID-CHAIN.md.
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
# Chain 100 is not a knob: an app resolves the Swarm contract addresses from
# the chain id, and this snapshot carries them at their Gnosis addresses.
CMD ["--chain-id", "100", \
     "--block-time", "5", \
     "--host", "0.0.0.0", \
     "--port", "9545", \
     "--state", "/data/state.gnosis.json", \
     "--state-interval", "30"]
