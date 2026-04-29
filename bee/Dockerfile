# syntax=docker/dockerfile:1.7
ARG BEE_VERSION=2.7.1
FROM ethersphere/bee:${BEE_VERSION}

# ROLE = queen | worker-1 | worker-2 | worker-3 | worker-4
# Selects which pre-generated dev identity (libp2p / swarm / pss keys) is baked
# into /home/bee/.bee. These keys are the deterministic ones shipped by
# @fairdatasociety/fdp-play. The Ethereum address Bee derives from each
# swarm.key is hardcoded in blockchain/deploy/script/Deploy.s.sol's _beeNodes()
# and gets 100 ETH + 100k BZZ during the deploy, so on first boot Bee finds a
# funded EOA and immediately deploys its chequebook against the pre-deployed
# SimpleSwapFactory.
ARG ROLE=queen
COPY --chown=bee:bee data/${ROLE}/ /home/bee/.bee/
