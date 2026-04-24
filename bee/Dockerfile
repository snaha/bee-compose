# syntax=docker/dockerfile:1.7
ARG BEE_VERSION=2.7.1
FROM ethersphere/bee:${BEE_VERSION}

# ROLE = queen | worker-1 | worker-2 | worker-3 | worker-4
# Selects which pre-generated dev identity (keys + chequebook) is baked into /home/bee/.bee.
# These identities are the deterministic keys shipped by @fairdatasociety/fdp-play — their
# chequebook addresses are pre-funded by the fdp-play-blockchain genesis, so Bee skips the
# normal funding step on first boot.
ARG ROLE=queen
COPY --chown=bee:bee data/${ROLE}/ /home/bee/.bee/
