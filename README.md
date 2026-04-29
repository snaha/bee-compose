# bee-compose

A self-contained Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster against a dev blockchain. One queen + up to eight workers (any mix of light and full nodes), all pre-funded and ready to upload.

Useful for:

- developing apps against Bee without touching mainnet
- integration tests that need a real Bee + chain
- experimenting with multi-node behavior (replication, retrieval, neighborhood routing)

## What you get

| Service        | Container                  | Host port(s)               | Notes                                          |
| -------------- | -------------------------- | -------------------------- | ---------------------------------------------- |
| `blockchain`   | `bee-compose-blockchain`   | `9545` RPC                 | Anvil booted from a baked snapshot             |
| `queen`        | `bee-compose-queen`        | `1633` API, `1634` p2p     | Full node, always running                      |
| `worker-1..8`  | `bee-compose-worker-N`     | `1633N` API, `1634N` p2p   | Light or full (opt-in via `--light` / `--full`) |

So worker-1's API is `127.0.0.1:16331`, worker-8's is `127.0.0.1:16338`. p2p ports follow the same pattern: `127.0.0.1:1634N`.

The blockchain is **Anvil** (Foundry) loaded from `blockchain/state.anvil.json` — a state snapshot produced by deploying the Swarm contracts (`ethersphere/storage-incentives` + `ethersphere/swap-swear-and-swindle`) from source via a Foundry script under `blockchain/deploy/`. The snapshot bakes in the 6 contracts at deterministic addresses, all AccessControl role wiring, an initial oracle price, and 100 ETH + 100 000 BZZ pre-funded on each Bee node EOA. Anvil starts in <1s and has no on-disk chaindata; the full state lives in the image layer.

Network ID `4020`. Contracts pinned in [`compose.yml`](./compose.yml) `x-bee-env`.

## Quick start

There are two equivalent paths. **Both run the same `compose.yml` underneath** — pick whichever fits your workflow.

### Option A: Node CLI (cross-platform, recommended)

Works on macOS, Linux, and Windows. Requires Node 18+ and Docker.

```bash
# install (one of)
pnpm dlx @snaha/bee-compose start --light 4     # no install
pnpm add -g @snaha/bee-compose                  # global install, then `bee-compose ...`

# common workflows  (--full counts ALL full nodes including the queen)
bee-compose start                               # queen only (default: --full 1 --light 0)
bee-compose start --light 4                     # queen + 4 light workers
bee-compose start --full 3 --light 2            # queen + 2 full workers + 2 light workers
bee-compose start --full 9                      # queen + 8 full workers (max)
bee-compose start --light 2 --pull              # queen + 2 light workers, refresh base images first
bee-compose start --fresh                       # wipe volumes and start clean
bee-compose stamp                               # buy a postage stamp on the queen
bee-compose stamp --node http://127.0.0.1:16331 # ...or on worker-1
bee-compose logs queen --follow
bee-compose status
bee-compose stop                                # stops containers, keeps volumes
bee-compose stop --rm                           # full teardown (down -v)
```

Run `bee-compose --help` or `bee-compose <cmd> --help` for the full surface. See [CLI reference](#cli-reference) below.

### Option B: shell scripts (Linux/macOS only)

For the no-Node path, a handful of shell scripts drive the same `compose.yml` directly. They need `bash`, `curl`, and `python3` (used inline for JSON parsing); workers come up as light nodes by default — flip per-worker `BEE_WORKER_N_FULL` env vars to switch them to full.

```bash
docker compose up -d                                # queen + chain (workers stay opt-in)
./scripts/workers-up.sh                             # add all 8 light workers (resolves queen's peer id into QUEEN_BOOTNODE)
BEE_WORKER_1_FULL=true ./scripts/workers-up.sh      # ...with worker-1 as a full node
./scripts/buy-stamp.sh                              # buy a postage stamp on the queen (~29h headroom on a 5s-block chain)
./scripts/buy-stamp.sh 500000000 20                 # ...with explicit amount and depth
BEE_API=http://127.0.0.1:16331 ./scripts/buy-stamp.sh   # ...on worker-1 instead
./scripts/fresh.sh                                  # nuke volumes, rebuild images against latest upstream bases, bring queen back up
./scripts/redeploy-contracts.sh                     # regenerate blockchain/state.anvil.json from source (rare; requires submodules)
```

Queen API: <http://127.0.0.1:1633>. Workers: `http://127.0.0.1:1633{N}` for `N` in `1..8`. The shell-script path doesn't have a "start a subset of workers" shortcut — `workers-up.sh` brings up the whole `workers` profile. To run a specific subset, pass service names yourself: `QUEEN_BOOTNODE=$(...) docker compose --profile workers up -d worker-1 worker-2`.

## CLI reference

All flags below take effect on the next compose invocation; nothing is persisted to a config file.

### `bee-compose start`

| Flag | Default | Notes |
| --- | --- | --- |
| `-F, --full <n>` | `1` | **Total** full nodes including the queen. Min 1 (queen is always full + always running). `--full 1` = queen only; `--full 3` = queen + 2 full workers. Max 9 (queen + 8 workers). |
| `-l, --light <n>` | `0` | Number of light worker nodes to start, in addition to whatever `--full` configures. |
| `--bee-version <ver>` | `2.7.1` | Upstream Bee image tag. Used at `docker compose build` time — re-runs of `start` with a new value rebuild the bee images. |
| `--foundry-version <ver>` | `stable` | Foundry image tag for the Anvil container. |
| `-d, --detach` / `--no-detach` | detach | Default returns once everything is up. `--no-detach` tails logs in the foreground; Ctrl-C only stops the log stream, the cluster keeps running. |
| `-f, --fresh` | off | `down -v --remove-orphans` (across the `workers` profile too) before starting. Destroys node state. |
| `--pull` | off | `docker compose pull` before starting. Refreshes the upstream Bee + Foundry images. |
| `--without-bees` | off | Start `blockchain` only — useful for poking at Anvil without spinning up Bee. |

**Allocation:** queen is always worker-0 conceptually. Of the workers, `1..(--full - 1)` are full and `(--full)..(--full - 1 + --light)` are light. So `--full 3 --light 2` runs:

- queen (full, always)
- worker-1, worker-2 (full)
- worker-3, worker-4 (light)

Re-running with the same `--full` value keeps each worker's type stable.

### `bee-compose stop`

| Flag | Default | Notes |
| --- | --- | --- |
| `--rm` | off | `down -v --remove-orphans` instead of `stop`. Removes containers and named volumes; the next `start` rebuilds from a clean slate. |

### `bee-compose logs <service>`

`<service>` ∈ `queen | blockchain | worker-1 .. worker-8`.

| Flag | Default | Notes |
| --- | --- | --- |
| `-f, --follow` | off | Stream new log lines (Ctrl-C to detach). |
| `-t, --tail <n>` | `100` | Show last N lines before following. |

### `bee-compose stamp`

| Flag | Default | Notes |
| --- | --- | --- |
| `--amount <n>` | `500000000` | Must be strictly greater than `oracle.price × 17280 = 414 720 000`. See Gotchas in [CLAUDE.md](./CLAUDE.md). |
| `--depth <n>` | `20` | Stamp depth (chunks-per-batch is `2^depth`). |
| `--node <url>` | `http://127.0.0.1:1633` | Target Bee node. Set to `http://127.0.0.1:1633N` (e.g. `16331` for worker-1, `16338` for worker-8) to buy on a worker. The `BEE_API` env var is honored as a fallback. |

### `bee-compose status`

Wraps `docker compose ps --profile workers` so worker services show up regardless of state.

### `bee-compose redeploy`

Regenerates `blockchain/state.anvil.json` by deploying the Swarm contracts from source. **Only works from a git checkout with submodules** — fails fast on a tarball install with a clear pointer to clone the repo.

| Flag | Default | Notes |
| --- | --- | --- |
| `--foundry-image <image>` | `ghcr.io/foundry-rs/foundry:stable` | Override the Foundry image used to boot the scratch Anvil and run `forge script`. `FOUNDRY_IMAGE` env var also honored. |

## Configuration via compose.yml

The shell-script path and direct `docker compose` users can use these env vars; the CLI exposes all of them as flags too.

- `BEE_VERSION` (default `2.7.1`) — upstream Bee image tag. `BEE_VERSION=2.8.0 docker compose build`.
- `FOUNDRY_VERSION` (default `stable`) — Foundry image tag for the Anvil blockchain.
- Worker count + roles — 8 worker services are defined, all behind the `workers` profile. `BEE_FULL_NODE` is per-worker via `BEE_WORKER_N_FULL` env vars (default `false`/light); the CLI sets these before `up`. To do it manually: `BEE_WORKER_1_FULL=true BEE_WORKER_2_FULL=true QUEEN_BOOTNODE=$(...) docker compose --profile workers up -d worker-1 worker-2 worker-3`. To define more than 8, run `scripts/generate-identities.sh 9 12` then update `_beeNodes()` in `Deploy.s.sol` and add service blocks to `compose.yml`.
- Stamp purchase target — `BEE_API` env var on `buy-stamp.sh` overrides the API endpoint (default queen at `127.0.0.1:1633`); set e.g. `BEE_API=http://127.0.0.1:16331` to buy on worker-1.
- Foundry image used by `redeploy-contracts.sh` / `bee-compose redeploy` — `FOUNDRY_IMAGE` env var (default `ghcr.io/foundry-rs/foundry:stable`).
- Stamp parameters — `./scripts/buy-stamp.sh <amount> <depth>`. Defaults to `500000000` / depth `20`. The amount must be strictly greater than `oracle.price * minValidityBlocks` (24000 × 17280 = 414 720 000) — see Gotchas in [CLAUDE.md](./CLAUDE.md).

## Adding more workers (beyond 8)

The 8-worker cap is a baking decision, not a hard limit. To add more:

```bash
# 1. Generate identities for the new workers (creates bee/data/worker-9/, ... worker-12/).
./scripts/generate-identities.sh 9 12

# 2. The script prints each new EOA. Add them to _beeNodes() in
#    blockchain/deploy/script/Deploy.s.sol (and bump the array size to 13).

# 3. Bake the new EOAs into state.anvil.json.
node bin/bee-compose.js redeploy

# 4. Add 4 new worker service blocks to compose.yml (copy worker-8, increment).
#    Use the next free port: worker-N → 1633N for N up to 9; for N≥10
#    pick a different scheme (e.g. 17000+N).

# 5. Update src/commands/start.ts MAX_WORKERS, src/commands/logs.ts VALID_SERVICES,
#    and rebuild: pnpm build.
```

This is intentionally manual — bumping past 8 is rare enough that scripting it isn't worth the complexity. If you find yourself doing it often, the right move is the runtime-mounted-identities refactor (see CLAUDE.md "Architecture").

## How the pre-funding works

`bee/data/{queen,worker-N}/keys/` holds deterministic libp2p / swarm / pss keys. The queen + worker-1..4 keys come from [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play); worker-5..8 are generated locally by `scripts/generate-identities.sh`. The Ethereum address Bee derives from each `swarm.key` is hardcoded into `blockchain/deploy/script/Deploy.s.sol`'s `_beeNodes()` list and gets 100 ETH + 100 000 BZZ during the deploy. So on first boot:

1. Bee reads its baked keys.
2. Sees its account has gas + BZZ, deploys its chequebook against the pre-deployed factory, and reaches `synced`.

Don't change the keys without redeploying the contracts (`scripts/redeploy-contracts.sh`) — the EOA addresses are paired.

## Redeploying the contracts

The committed `blockchain/state.anvil.json` is produced by `scripts/redeploy-contracts.sh`, which boots a scratch Anvil, runs `blockchain/deploy/script/Deploy.s.sol` against it (fresh deploys of `storage-incentives` + `swap-swear-and-swindle` from pinned tags), and dumps the resulting state. To regenerate (e.g. after bumping a contract submodule):

```bash
./scripts/redeploy-contracts.sh
docker compose build blockchain   # bake the new state into the image
```

The script prints the resulting contract addresses at the end. If they changed (they will if you bumped a submodule), update `compose.yml`'s `x-bee-env` block to match. Day-to-day workflows (`up`, `down`, `fresh.sh`) don't touch this path.

To bump a contract submodule:

```bash
cd blockchain/deploy
git -C lib/storage-incentives fetch --tags
git -C lib/storage-incentives checkout v0.9.5     # for example
cd ../..
git add blockchain/deploy/lib/storage-incentives  # record the new SHA
./scripts/redeploy-contracts.sh
```

## Developing the CLI

```bash
pnpm install        # install dev deps
pnpm build          # compile TS to dist/
pnpm dev            # watch mode
node bin/bee-compose.js start --light 2      # run locally without `pnpm link`
```

The `compose.yml`, Dockerfiles, baked Anvil state, and dev identities are all bundled into the published tarball (`pnpm pack` to inspect). Submodules under `blockchain/deploy/lib/` are excluded — `redeploy` only works from a git checkout.

## Prior art

- [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play) — the upstream "Bee + chain in a box" CLI. `bee-compose` is a compose-native take on the same idea: a `compose.yml` is the source of truth, the chain is Anvil booted from a state snapshot deployed from upstream Solidity sources (no upstream geth image at any point), and there's a thin Node CLI (`@snaha/bee-compose`) that wraps `docker compose` for cross-platform UX. The queen + worker-1..4 dev identities still come from fdp-play; worker-5..8 are generated locally by `scripts/generate-identities.sh`.

## License

[Apache 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution of bundled upstream assets (Swarm Bee base image, Foundry/Anvil base image, fdp-play dev identities, `ethersphere/storage-incentives` and `ethersphere/swap-swear-and-swindle` Solidity sources).
