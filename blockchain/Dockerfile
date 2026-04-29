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
ARG FOUNDRY_VERSION=stable
FROM ghcr.io/foundry-rs/foundry:${FOUNDRY_VERSION}

COPY --chown=foundry:foundry state.anvil.json /state.anvil.json

EXPOSE 9545
ENTRYPOINT ["anvil"]
CMD ["--chain-id", "4020", \
     "--block-time", "5", \
     "--host", "0.0.0.0", \
     "--port", "9545", \
     "--load-state", "/state.anvil.json"]
