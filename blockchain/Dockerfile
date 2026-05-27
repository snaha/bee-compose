# syntax=docker/dockerfile:1.7
# Anvil-backed dev chain for bee-compose.
#
# state.anvil.json is produced by scripts/redeploy-contracts.sh, which deploys
# the Swarm contracts from source (storage-incentives + swap-swear-and-swindle
# pinned via git submodules under blockchain/deploy/lib/) onto a scratch Anvil
# and dumps the resulting state. The snapshot baked into this image contains:
#   - the 6 Swarm contracts at the addresses in compose.yml's x-bee-env
#   - one ERC20SimpleSwap master clone target
#   - role grants wiring oracle / redistribution to postage + staking
#   - the 5 Bee node EOAs pre-funded with 100 ETH + 100k BZZ each
# Bumping any contract submodule means rerunning the redeploy script.
#
# Runtime state is kept on a named volume mounted at /data; the entrypoint
# copies the baked snapshot into the volume on first boot and anvil's
# `--state` loads/dumps from that path so chain state survives restarts.
ARG FOUNDRY_VERSION=stable
FROM ghcr.io/foundry-rs/foundry:${FOUNDRY_VERSION}

COPY --chown=foundry:foundry state.anvil.json /state.anvil.json
COPY --chown=foundry:foundry --chmod=0755 entrypoint.sh /entrypoint.sh

USER root
RUN mkdir -p /data && chown foundry:foundry /data
USER foundry

EXPOSE 9545
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--chain-id", "4020", \
     "--block-time", "5", \
     "--host", "0.0.0.0", \
     "--port", "9545", \
     "--state", "/data/state.anvil.json", \
     "--state-interval", "30"]
