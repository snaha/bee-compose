# bee-compose

A self-contained Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster against a dev blockchain. One queen + up to eight workers (any mix of light and full nodes), all pre-funded and ready to upload.

Useful for:

- developing apps against Bee without touching mainnet
- integration tests that need a real Bee + chain
- experimenting with multi-node behavior (replication, retrieval, neighborhood routing)

## The chain

Chain 100, served offline from a **hybrid snapshot**: Gnosis mainnet's BZZ token,
WXDAI and SushiSwap pools — a BZZ market can only be borrowed — with the Swarm
contracts deployed from source on top at their mainnet addresses. So postage
bought the way a product buys it (swap xDAI for BZZ, then `createBatch`) is
postage these nodes recognise, and it keeps working, where a plain mainnet dump
reverts `BatchDoesNotExist()` for good after a handful of purchases.

Two things to know as a user; [`blockchain/README.md`](blockchain/README.md) has
the mechanism, the limits and how to re-bake.

- **Money lives on the faucet, not the nodes.**
  `0xF406AebbF610A9c54589e7EbE25b8e6621258410` holds every payment token — 100
  xDAI, 250 BZZ, 5 000 WXDAI and 5 000 USDC. The key is
  `keccak256("bee-compose dev faucet")` — publicly known by construction,
  worthless anywhere else. Fund test addresses from it by plain transfer: the
  pool is real, thin (~$1.2k) and shared by every purchase this chain will ever
  serve. The nine node EOAs get 100 xDAI for gas and 10 BZZ for their own
  postage, so `POST /stamps` / `bee-compose stamp` / `buy-stamp.sh` work without
  touching the pool. See [The dev faucet](#the-dev-faucet) for the private key,
  the token addresses and a copy-paste transfer.
- **Swap is off, and storage incentives do not play.** A chequebook needs xBZZ
  and a factory deployment; uploading with your own stamps needs neither. The
  nodes hold no stake, so the redistribution agent logs `phase failed` every
  round — harmless for upload/download work.

## What you get

| Service        | Container                  | Host port(s)               | Notes                                          |
| -------------- | -------------------------- | -------------------------- | ---------------------------------------------- |
| `blockchain`   | `bee-compose-blockchain`   | `9545` RPC                 | Anvil booted from a baked snapshot             |
| `queen`        | `bee-compose-queen`        | `1633` API, `1634` p2p     | Full node, always running                      |
| `worker-1..8`  | `bee-compose-worker-N`     | `1633N` API, `1634N` p2p   | Light or full (opt-in via `--light` / `--full`) |

So worker-1's API is `127.0.0.1:16331`, worker-8's is `127.0.0.1:16338`. p2p ports follow the same pattern: `127.0.0.1:1634N`.

The blockchain is **Anvil** loaded from `blockchain/state.gnosis.json`, and starts in <1s. The snapshot seeds a `blockchain` named volume on first boot; anvil's `--state` loads from and dumps to that volume, so chain state (stamps bought, transactions sent) survives `stop`/`start` alongside the Bee node volumes. `--rm` / `--fresh` wipes it back to the baked snapshot.

Network ID `4020` — the swarm's identity, unrelated to the chain id. Contract addresses pinned in [`compose.yml`](./compose.yml) `x-bee-env`.

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
pnpm bake                                           # re-bake blockchain/state.gnosis.json (rare; needs internet + submodules)
```

Queen API: <http://127.0.0.1:1633>. Workers: `http://127.0.0.1:1633{N}` for `N` in `1..8`. The shell-script path doesn't have a "start a subset of workers" shortcut — `workers-up.sh` brings up the whole `workers` profile. To run a specific subset, pass service names yourself: `QUEEN_BOOTNODE=$(...) docker compose --profile workers up -d worker-1 worker-2`.

## CLI reference

All flags below take effect on the next compose invocation; nothing is persisted to a config file.

### `bee-compose start`

| Flag | Default | Notes |
| --- | --- | --- |
| `-F, --full <n>` | `1` | **Total** full nodes including the queen. Min 1 (queen is always full + always running). `--full 1` = queen only; `--full 3` = queen + 2 full workers. Max 9 (queen + 8 workers). |
| `-l, --light <n>` | `0` | Number of light worker nodes to start, in addition to whatever `--full` configures. |
| `--bee-version <ver>` | `2.8.0` | Upstream Bee image tag. Used at `docker compose build` time — re-runs of `start` with a new value rebuild the bee images. |
| `--foundry-version <ver>` | `stable` | Foundry image tag for the Anvil container. |
| `-d, --detach` / `--no-detach` | detach | Default returns once everything is up. `--no-detach` tails logs in the foreground; Ctrl-C only stops the log stream, the cluster keeps running. |
| `-f, --fresh` | off | `down -v --remove-orphans` (across the `workers` profile too) before starting. Destroys node state. |
| `--pull` | off | `docker compose build --pull` before starting. Refreshes the upstream Bee + Foundry base images and rebuilds the local `bee-compose:*` images on top. |
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

## Configuration via compose.yml

The shell-script path and direct `docker compose` users can use these env vars; the CLI exposes all of them as flags too.

- `BEE_VERSION` (default `2.8.0`) — selects both the upstream Bee base image tag and the bee **source tag** (`v${BEE_VERSION}`) that gets recompiled with `reachabilityOverridePublic=true` (required for non-deferred uploads to replicate on the bridge network — see [issue #11](https://github.com/snaha/bee-compose/issues/11)). `BEE_VERSION=2.8.0 docker compose build`. The first build compiles bee from source (a few minutes; cached afterward and shared across all node images).
- `FOUNDRY_VERSION` (default `stable`) — Foundry image tag for the Anvil blockchain.
- Worker count + roles — 8 worker services are defined, all behind the `workers` profile. `BEE_FULL_NODE` is per-worker via `BEE_WORKER_N_FULL` env vars (default `false`/light); the CLI sets these before `up`. To do it manually: `BEE_WORKER_1_FULL=true BEE_WORKER_2_FULL=true QUEEN_BOOTNODE=$(...) docker compose --profile workers up -d worker-1 worker-2 worker-3`. To define more than 8, run `scripts/generate-identities.sh 9 12`, re-bake (the bake reads every `bee/data/*/keys/swarm.key`), and add service blocks to `compose.yml`.
- Stamp purchase target — `BEE_API` env var on `buy-stamp.sh` overrides the API endpoint (default queen at `127.0.0.1:1633`); set e.g. `BEE_API=http://127.0.0.1:16331` to buy on worker-1.
- Stamp parameters — `./scripts/buy-stamp.sh <amount> <depth>`. Defaults to `500000000` / depth `20`. The amount must be strictly greater than `oracle.price * minValidityBlocks` (24000 × 17280 = 414 720 000) — see Gotchas in [CLAUDE.md](./CLAUDE.md).
- Re-baking the chain — `GNOSIS_RPC_URL`, `GNOSIS_FORK_BLOCK`, `FOUNDRY_IMAGE`; see [`blockchain/README.md`](blockchain/README.md).

## Adding more workers (beyond 8)

The 8-worker cap is a baking decision, not a hard limit. To add more:

```bash
# 1. Generate identities for the new workers (creates bee/data/worker-9/, ... worker-12/).
./scripts/generate-identities.sh 9 12

# 2. Re-bake so the new EOAs are funded. The bake reads every
#    bee/data/*/keys/swarm.key, so there is no list to update by hand.
pnpm bake && docker compose build blockchain

# 3. Add 4 new worker service blocks to compose.yml (copy worker-8, increment).
#    Use the next free port: worker-N → 1633N for N up to 9; for N≥10
#    pick a different scheme (e.g. 17000+N).

# 4. Update src/commands/start.ts MAX_WORKERS, src/commands/logs.ts VALID_SERVICES,
#    and rebuild: pnpm build.
```

This is intentionally manual — bumping past 8 is rare enough that scripting it isn't worth the complexity. If you find yourself doing it often, the right move is the runtime-mounted-identities refactor (see CLAUDE.md "Architecture").

## The dev faucet

Test funding comes from one pre-funded wallet baked into the snapshot — there
is no faucet service to run. Import the key into whatever signs your
transactions (viem, ethers, `cast`, MetaMask) and transfer what you need.

|             | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Address     | `0xF406AebbF610A9c54589e7EbE25b8e6621258410`                         |
| Private key | `0xc50a4bc364bb2f90007c01e3dc68c5bbc5451d4f7465510e8cffde8c137e6cf9` |

The key is `keccak256("bee-compose dev faucet")` — publicly known by
construction, re-derivable rather than memorised, and worthless anywhere but
this offline chain. The faucet holds every token a payment can be made in:

| Token         | Amount | Decimals | Address                                      |
| ------------- | ------ | -------- | -------------------------------------------- |
| xDAI (native) | 100    | 18       | —                                            |
| BZZ           | 250    | 16       | `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da` |
| WXDAI         | 5 000  | 18       | `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` |
| USDC          | 5 000  | 6        | `0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83` |

Fund a test account with a plain transfer — for example 1 BZZ (16 decimals)
with foundry's `cast`, against a running cluster:

```bash
cast send 0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da \
  'transfer(address,uint256)' <recipient> 10000000000000000 \
  --private-key 0xc50a4bc364bb2f90007c01e3dc68c5bbc5451d4f7465510e8cffde8c137e6cf9 \
  --rpc-url http://127.0.0.1:9545
```

**Transfer, never swap.** The SushiSwap pools in the snapshot are real, thin,
and shared by every purchase this chain will ever serve — a swap-funded float
moves the very price the product quotes against, while a transfer moves
nothing. That is why the faucet exists. Balances reset to the table above
whenever the chain volume is torn down (`bee-compose stop --rm`, `fresh.sh`,
`docker compose --profile workers down -v`).

## How the pre-funding works

`bee/data/{queen,worker-N}/keys/` holds deterministic libp2p / swarm / pss keys — queen + worker-1..4 from [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play), worker-5..8 generated locally by `scripts/generate-identities.sh`. The bake reads the Ethereum address out of every `swarm.key` keystore and funds it in the snapshot, so on first boot Bee reads its baked keys, sees a funded account, and reaches `synced`. Keys and snapshot are paired: don't change one without re-baking.

## Developing the CLI

```bash
pnpm install        # install dev deps
pnpm build          # compile TS to dist/
pnpm dev            # watch mode
node bin/bee-compose.js start --light 2      # run locally without `pnpm link`
```

The `compose.yml`, Dockerfiles, baked Anvil state, and dev identities are all bundled into the published tarball (`pnpm pack` to inspect). Nothing under `blockchain/deploy/` or `blockchain/bake/` ships — re-baking needs a git checkout with submodules, and internet.

## Prior art

- [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play) — the upstream "Bee + chain in a box" CLI. `bee-compose` is a compose-native take on the same idea: `compose.yml` is the source of truth, the chain is Anvil on a snapshot that borrows Gnosis mainnet's BZZ market rather than replaying an upstream geth image, and the Node CLI is a thin `docker compose` wrapper for cross-platform UX. The queen + worker-1..4 dev identities still come from fdp-play.

## License

[Apache 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution of bundled upstream assets (Swarm Bee base image, Foundry/Anvil base image, fdp-play dev identities, `ethersphere/storage-incentives` Solidity sources).
