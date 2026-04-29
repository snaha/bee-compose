#!/usr/bin/env bash
# Regenerate blockchain/state.anvil.json by deploying the Swarm contracts
# from source onto a scratch Anvil instance.
#
# How it works
# ------------
# 1. Make sure submodules under blockchain/deploy/lib/ are present.
# 2. Boot a scratch Anvil (chain-id 4020) in a Docker container.
# 3. Run blockchain/deploy/script/Deploy.s.sol via `forge script` against it.
#    The script uses plain CREATE from a fixed deployer EOA (Anvil's account[0])
#    at sequential nonces, so addresses are stable across runs as long as the
#    bytecode and deploy order don't change. See Deploy.s.sol for the
#    "why not CREATE2" rationale (AccessControl admin would land on the
#    CREATE2 proxy, not our EOA).
# 4. Call `anvil_dumpState` and write the result to blockchain/state.anvil.json.
#
# Run this when bumping a contract submodule or changing the deploy script.
# Commit the new state file. If addresses changed, also update compose.yml's
# x-bee-env block — they're printed at the end of the run.
#
# Runtime image (blockchain/Dockerfile) uses `anvil --load-state /state.anvil.json`;
# nothing in this script runs at runtime.

set -euo pipefail
cd "$(dirname "$0")/.."

FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:stable}"
ANVIL_NAME="redeploy-anvil-$$"
ANVIL_PORT=18545
DEPLOY_DIR="blockchain/deploy"
OUT="blockchain/state.anvil.json"

# Anvil's first default account — well-known dev key, not secret.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

cleanup() { docker rm -f "$ANVIL_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== ensuring submodules are initialized =="
# Non-recursive on purpose: recursing into OZ pulls in halmos-cheatcodes /
# erc4626-tests / forge-std clones whose presence trips foundry's
# auto-detected remappings. We override remappings explicitly in
# remappings.txt, but it's still cleanest not to fetch the noise.
git submodule update --init \
  "$DEPLOY_DIR/lib/forge-std" \
  "$DEPLOY_DIR/lib/openzeppelin-contracts" \
  "$DEPLOY_DIR/lib/openzeppelin-contracts-v3-solc-0.7" \
  "$DEPLOY_DIR/lib/storage-incentives" \
  "$DEPLOY_DIR/lib/swap-swear-and-swindle"

echo "== pulling foundry image =="
docker pull "$FOUNDRY_IMAGE" >/dev/null

echo "== booting scratch anvil =="
docker run -d --name "$ANVIL_NAME" \
  -p "127.0.0.1:${ANVIL_PORT}:8545" \
  --entrypoint anvil "$FOUNDRY_IMAGE" \
  --chain-id 4020 --host 0.0.0.0 --port 8545 >/dev/null

for i in $(seq 1 30); do
  if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "http://127.0.0.1:${ANVIL_PORT}" 2>/dev/null | grep -q '"result"'; then
    break
  fi
  [ "$i" = "30" ] && { echo "anvil didn't come up" >&2; exit 1; }
  sleep 1
done

echo "== running forge script (deploys + role wiring + funding) =="
# Mount the deploy dir into a foundry container; it shares the host network
# so it can reach the anvil container via 127.0.0.1.
docker run --rm \
  --network host \
  -v "$PWD/$DEPLOY_DIR:/work" -w /work \
  -e PRIVATE_KEY="$DEPLOYER_KEY" \
  --entrypoint forge "$FOUNDRY_IMAGE" \
  script script/Deploy.s.sol \
  --rpc-url "http://127.0.0.1:${ANVIL_PORT}" \
  --broadcast \
  --slow \
  -vvv

echo "== dumping anvil state =="
# anvil_dumpState returns hex of gzipped JSON; runtime image's --load-state
# wants plain JSON, so gunzip before writing to disk.
DUMP_HEX=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"anvil_dumpState","params":[]}' \
  "http://127.0.0.1:${ANVIL_PORT}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"])')

python3 - <<PY
import gzip, io, sys
hex_data = "$DUMP_HEX"
raw = bytes.fromhex(hex_data[2:] if hex_data.startswith("0x") else hex_data)
plain = gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb").read()
with open("$OUT", "wb") as f:
    f.write(plain)
print(f"wrote $OUT ({len(plain):,} bytes)")
PY

echo "== done =="
ls -lh "$OUT"
echo
echo "If contract addresses changed, update compose.yml's x-bee-env block"
echo "with the values printed by the forge script above."
