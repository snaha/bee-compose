# syntax=docker/dockerfile:1.7
# Anvil-backed dev chain for bee-compose.
#
# state.anvil.json is rebaked from fairdatasociety/fdp-play-blockchain via
# scripts/rebake-blockchain.sh. It preserves every deployed Swarm contract
# (factory, postage stamp, price oracle, staking, redistribution) at the
# addresses pinned in compose.yml's x-bee-env, plus the 11 genesis-funded
# EOAs that Bee nodes draw gas from.
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
