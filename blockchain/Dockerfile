# syntax=docker/dockerfile:1.7
# Gnosis-backed dev chain for bee-compose.
#
# state.gnosis.json is a HYBRID snapshot — mainnet's BZZ market with the Swarm
# contracts deployed from source on top at their mainnet addresses, plus funded
# node EOAs and a dev faucet. Needs no internet to serve, does need it to
# re-bake. What is in it and why it is built the way it is: ./README.md.
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
