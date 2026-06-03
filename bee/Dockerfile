# syntax=docker/dockerfile:1.7
ARG BEE_VERSION=2.7.1

# Recompile bee with reachabilityOverridePublic=true. The stock ethersphere/bee
# image is built with this OFF, and it's a compile-time Go ldflag — NOT settable
# by any BEE_* env var. On a docker bridge network libp2p AutoNAT never confirms
# reachability, so each node's own reachability stays Unknown; bee's pushsync only
# stores + returns a receipt when IsReachable() is true, so with it off no node
# ever takes the store-and-receipt branch. Non-deferred uploads then forward
# forever and hang ~30s (defaultTTL) without ever replicating. A local dev cluster
# wants every node to treat itself as publicly reachable. See issue #11.
FROM golang:1.25 AS builder
ARG BEE_VERSION
RUN git clone --depth 1 --branch v${BEE_VERSION} https://github.com/ethersphere/bee.git /src
WORKDIR /src
# make binary bakes the reachabilityOverridePublic ldflag (plus version/commit/api
# ldflags) and builds a static binary (CGO disabled) to /src/dist/bee.
RUN make binary REACHABILITY_OVERRIDE_PUBLIC=true

FROM ethersphere/bee:${BEE_VERSION}
# Swap the stock binary for the reachability-overridden one; the stock image's
# entrypoint (["bee"]), user (bee, uid/gid 999), volume, and layout stay intact.
COPY --from=builder /src/dist/bee /usr/local/bin/bee

# ROLE = queen | worker-1 | worker-2 | ... | worker-8
# Selects which pre-generated dev identity (libp2p / swarm / pss keys) is baked
# into /home/bee/.bee. The queen + worker-1..4 keys are the deterministic ones
# shipped by @fairdatasociety/fdp-play; worker-5..8 were generated locally via
# scripts/generate-identities.sh. The Ethereum address Bee derives from each
# swarm.key is hardcoded in blockchain/deploy/script/Deploy.s.sol's _beeNodes()
# and gets 100 ETH + 100k BZZ during the deploy, so on first boot Bee finds a
# funded EOA and immediately deploys its chequebook against the pre-deployed
# SimpleSwapFactory.
ARG ROLE=queen
COPY --chown=bee:bee data/${ROLE}/ /home/bee/.bee/
