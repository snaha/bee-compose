# bee-compose

A self-contained Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster against a dev blockchain. One queen + up to four workers, all pre-funded and ready to upload.

Useful for:

- developing apps against Bee without touching mainnet
- integration tests that need a real Bee + chain
- experimenting with multi-node behavior (replication, retrieval, neighborhood routing)

## What you get

| Service       | Container                  | Host port(s)         | Notes                              |
| ------------- | -------------------------- | -------------------- | ---------------------------------- |
| `blockchain`  | `bee-compose-blockchain`   | `9545` RPC           | Anvil booted from a baked snapshot |
| `queen`       | `bee-compose-queen`        | `1633` API, `1634` p2p | Full node, always running          |
| `worker-1..4` | `bee-compose-worker-N`     | `N1633`, `N1634`     | Light nodes, opt-in                |

The blockchain is **Anvil** (Foundry) loaded from `blockchain/state.anvil.json` — a state snapshot produced by deploying the Swarm contracts (`ethersphere/storage-incentives` + `ethersphere/swap-swear-and-swindle`) from source via a Foundry script under `blockchain/deploy/`. The snapshot bakes in the 6 contracts at deterministic addresses, all AccessControl role wiring, an initial oracle price, and 100 ETH + 100 000 BZZ pre-funded on each Bee node EOA. Anvil starts in <1s and has no on-disk chaindata; the full state lives in the image layer.

Network ID `4020`. Contracts pinned in [`compose.yml`](./compose.yml) `x-bee-env`.

## Quick start

There are two equivalent paths. **Both run the same `compose.yml` underneath** — pick whichever fits your workflow.

### Option A: Node CLI (cross-platform, recommended)

Works on macOS, Linux, and Windows. Requires Node 18+ and Docker.

```bash
# install (one of)
pnpm dlx @snaha/bee-compose start --workers 4    # no install
pnpm add -g @snaha/bee-compose                    # global install, then `bee-compose ...`

# common workflows
bee-compose start --workers 4         # queen + blockchain + 4 workers
bee-compose start --workers 2 --pull  # 2 workers, refresh base images first
bee-compose start --fresh             # wipe volumes and start clean
bee-compose stamp                     # buy a postage stamp on the queen
bee-compose stamp --node http://127.0.0.1:11633   # ...or on worker-1
bee-compose logs queen --follow
bee-compose status
bee-compose stop                      # stops containers, keeps volumes
bee-compose stop --rm                 # full teardown (down -v)
```

Run `bee-compose --help` or `bee-compose <cmd> --help` for the full surface. See [CLI reference](#cli-reference) below.

### Option B: shell scripts (Linux/macOS only)

For the no-Node path, the original shell scripts still work directly against `compose.yml`:

```bash
docker compose up -d                  # queen + chain
./scripts/workers-up.sh               # add workers (resolves queen's peer id, sets BEE_BOOTNODE)
./scripts/buy-stamp.sh                # buy a postage stamp (~29h headroom on a 5s-block chain)
./scripts/fresh.sh                    # nuke and rebuild from upstream bases
```

Queen API: <http://127.0.0.1:1633>. Workers: `http://127.0.0.1:{1,2,3,4}1633`.

## CLI reference

All flags below take effect on the next compose invocation; nothing is persisted to a config file.

### `bee-compose start`

| Flag | Default | Notes |
| --- | --- | --- |
| `-w, --workers <n>` | `0` | 0–4. >0 starts the queen first, resolves its peer id from `/addresses`, then exports `QUEEN_BOOTNODE` for the worker containers. |
| `--bee-version <ver>` | `2.7.1` | Upstream Bee image tag. Used at `docker compose build` time — re-runs of `start` with a new value rebuild the bee images. |
| `--foundry-version <ver>` | `stable` | Foundry image tag for the Anvil container. |
| `-d, --detach` / `--no-detach` | detach | Default returns once everything is up. `--no-detach` tails logs in the foreground; Ctrl-C only stops the log stream, the cluster keeps running. |
| `-f, --fresh` | off | `down -v --remove-orphans` (across the `workers` profile too) before starting. Destroys node state. |
| `--pull` | off | `docker compose pull` before starting. Refreshes the upstream Bee + Foundry images. |
| `--without-bees` | off | Start `blockchain` only — useful for poking at Anvil without spinning up Bee. |

### `bee-compose stop`

| Flag | Default | Notes |
| --- | --- | --- |
| `--rm` | off | `down -v --remove-orphans` instead of `stop`. Removes containers and named volumes; the next `start` rebuilds from a clean slate. |

### `bee-compose logs <service>`

`<service>` ∈ `queen | blockchain | worker-1 | worker-2 | worker-3 | worker-4`.

| Flag | Default | Notes |
| --- | --- | --- |
| `-f, --follow` | off | Stream new log lines (Ctrl-C to detach). |
| `-t, --tail <n>` | `100` | Show last N lines before following. |

### `bee-compose stamp`

| Flag | Default | Notes |
| --- | --- | --- |
| `--amount <n>` | `500000000` | Must be strictly greater than `oracle.price × 17280 = 414 720 000`. See Gotchas in [CLAUDE.md](./CLAUDE.md). |
| `--depth <n>` | `20` | Stamp depth (chunks-per-batch is `2^depth`). |
| `--node <url>` | `http://127.0.0.1:1633` | Target Bee node. Set to `http://127.0.0.1:11633` (etc.) to buy on a worker. The `BEE_API` env var is honored as a fallback. |

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
- Worker count — workers live behind the `workers` profile, so they only start when explicitly invoked (via `--profile workers` or `scripts/workers-up.sh` or `bee-compose start -w N`). To run a *subset* of the four defined workers, target them by name: `QUEEN_BOOTNODE=$(...) docker compose --profile workers up -d worker-1 worker-2`. To define more or fewer than four, edit `compose.yml` and add corresponding identities under `bee/data/`.
- Stamp purchase target — `BEE_API` env var on `buy-stamp.sh` overrides the API endpoint (default queen at `127.0.0.1:1633`); set e.g. `BEE_API=http://127.0.0.1:11633` to buy on worker-1.
- Foundry image used by `redeploy-contracts.sh` / `bee-compose redeploy` — `FOUNDRY_IMAGE` env var (default `ghcr.io/foundry-rs/foundry:stable`).
- Stamp parameters — `./scripts/buy-stamp.sh <amount> <depth>`. Defaults to `500000000` / depth `20`. The amount must be strictly greater than `oracle.price * minValidityBlocks` (24000 × 17280 = 414 720 000) — see Gotchas in [CLAUDE.md](./CLAUDE.md).

## How the pre-funding works

`bee/data/{queen,worker-N}/keys/` holds deterministic libp2p / swarm / pss keys originally generated by [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play). The Ethereum address Bee derives from each `swarm.key` is hardcoded into `blockchain/deploy/script/Deploy.s.sol`'s `_beeNodes()` list and gets 100 ETH + 100 000 BZZ during the deploy. So on first boot:

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

## Layout

```
.
├── compose.yml                       # services, env, ports, profiles — source of truth
├── bee/
│   ├── Dockerfile                    # FROM ethersphere/bee, COPYs role-specific keys
│   └── data/                         # pre-generated dev identities
├── blockchain/
│   ├── Dockerfile                    # FROM foundry, COPYs the state snapshot
│   ├── state.anvil.json              # baked Anvil state (committed)
│   └── deploy/                       # Foundry project that produces state.anvil.json
│       ├── foundry.toml
│       ├── remappings.txt
│       ├── script/Deploy.s.sol       # deploy + role wiring + funding orchestrator
│       ├── src/CompileFactory.sol    # solc-0.7.6 stub to drag SimpleSwapFactory into the build
│       └── lib/                      # tag-pinned submodules (storage-incentives, swap-swear-and-swindle, OZ x2, forge-std)
├── scripts/                          # bash entry points for the no-Node path
│   ├── workers-up.sh                 # resolves queen peer id, brings up workers profile
│   ├── buy-stamp.sh                  # POST /stamps with sane defaults, waits for settlement
│   ├── fresh.sh                      # nuke + rebuild + up
│   └── redeploy-contracts.sh         # regenerate state.anvil.json by deploying contracts from source
├── src/                              # @snaha/bee-compose CLI source (TypeScript)
│   ├── cli.ts
│   ├── commands/{start,stop,logs,stamp,status,redeploy}.ts
│   └── lib/{paths,exec,compose,bootnode}.ts
├── bin/bee-compose.js                # shebang shim → dist/cli.js
├── package.json                      # @snaha/bee-compose, pnpm-managed
└── tsconfig.json
```

## Developing the CLI

```bash
pnpm install        # install dev deps
pnpm build          # compile TS to dist/
pnpm dev            # watch mode
node bin/bee-compose.js start --workers 2   # run locally without `pnpm link`
```

The `compose.yml`, Dockerfiles, baked Anvil state, and dev identities are all bundled into the published tarball (`pnpm pack` to inspect). Submodules under `blockchain/deploy/lib/` are excluded — `redeploy` only works from a git checkout.

## Prior art

- [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play) — the upstream "Bee + chain in a box" CLI. `bee-compose` is a leaner, compose-native take: no node CLI wrapper, no upstream geth image at any point — just a `compose.yml`, an Anvil snapshot deployed from upstream Solidity sources, and a handful of shell scripts. The dev identities still come from fdp-play.

## License

[Apache 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution of bundled upstream assets (Swarm Bee base image, Foundry/Anvil base image, fdp-play dev identities, `ethersphere/storage-incentives` and `ethersphere/swap-swear-and-swindle` Solidity sources).
