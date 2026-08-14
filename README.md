# bee-compose

A self-contained Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster against a dev blockchain. One queen + up to eight workers (any mix of light and full nodes), all pre-funded and ready to upload.

Useful for:

- developing apps against Bee without touching mainnet
- integration tests that need a real Bee + chain
- experimenting with multi-node behavior (replication, retrieval, neighborhood routing)

## The chain

The cluster runs on chain 100 against a **hybrid snapshot**, baked into the
blockchain image and served with no internet:

- the **BZZ token, WXDAI and the SushiSwap router / quoter / BZZ pool** come
  from a dump of Gnosis mainnet, because a BZZ market cannot be deployed, only
  borrowed;
- the **Swarm contracts** (PostageStamp, PriceOracle, StakeRegistry,
  Redistribution) are deployed from source on top, onto their mainnet addresses.

So a batch bought the way a product buys it — swap xDAI for BZZ on the real
pool, then `createBatch` — is a batch these nodes recognise, and it keeps
working: the freshly deployed PostageStamp starts with an empty batch tree,
where a mainnet snapshot's tree is mostly missing from the dump and eventually
reverts `BatchDoesNotExist()` for good. See
[blockchain/HYBRID-CHAIN.md](blockchain/HYBRID-CHAIN.md) for the mechanism and
`pnpm verify:chain` for the check.

The nine Bee node EOAs ship pre-funded with 100 xDAI for gas and 10 BZZ for
their own postage, so `POST /stamps` / `bee-compose stamp` / `buy-stamp.sh`
work without touching the pool. Swap is off: a
chequebook needs xBZZ and a factory deployment, and uploading with your own
stamps needs neither.

There is also a **dev faucet** at `0xF406AebbF610A9c54589e7EbE25b8e6621258410`,
holding 100 xDAI and 250 BZZ. Its key is `keccak256("bee-compose dev faucet")` —
publicly known by construction, worthless anywhere else. It exists so tooling can
fund an address with a plain transfer: every swap moves a real, thin pool, and
this chain is long-lived.

### What the snapshot still cannot reproduce

- **Storage incentives do not play.** The nodes hold no stake, so the
  redistribution agent logs `phase failed` every round. Harmless for
  upload/download work.
- **The pool is thin and finite.** It carries the real pool's liquidity, which
  is small: about 180 WXDAI against 19 300 BZZ, roughly $1.2k. The bake warms
  ~49 xDAI of range in each direction, and ~0.5 xDAI of buying moves the price
  ~0.6% — so a few hundred purchases, not an unlimited number. Past that,
  re-bake or reset the volume.
- **Prices are frozen** at the block the snapshot was taken from.

### Re-baking the chain

Needs internet (it forks mainnet and downloads solc); replaying the result does
not.

```bash
pnpm install --ignore-workspace   # once
pnpm bake                         # rewrites blockchain/state.gnosis.json
docker compose build blockchain   # bake the new state into the image
```

The bake also rewrites `BEE_POSTAGE_STAMP_START_BLOCK` in `compose.yml` —
PostageStamp lands in a new block every time, and a stale value hides every
batch from the nodes with no error anywhere. Commit the two together. Contract
addresses do not change; the bake fails loudly if one lands elsewhere.

Set `GNOSIS_FORK_BLOCK` to fork a fixed height instead of the chain head, which
makes two bakes differ only where you changed something.

## What you get

| Service        | Container                  | Host port(s)               | Notes                                          |
| -------------- | -------------------------- | -------------------------- | ---------------------------------------------- |
| `blockchain`   | `bee-compose-blockchain`   | `9545` RPC                 | Anvil booted from a baked snapshot             |
| `queen`        | `bee-compose-queen`        | `1633` API, `1634` p2p     | Full node, always running                      |
| `worker-1..8`  | `bee-compose-worker-N`     | `1633N` API, `1634N` p2p   | Light or full (opt-in via `--light` / `--full`) |

So worker-1's API is `127.0.0.1:16331`, worker-8's is `127.0.0.1:16338`. p2p ports follow the same pattern: `127.0.0.1:1634N`.

The blockchain is **Anvil** (Foundry) loaded from `blockchain/state.gnosis.json` — the hybrid snapshot described above, produced by `blockchain/bake/bake.sh`. It carries the borrowed mainnet DEX and BZZ, the four Swarm contracts (`ethersphere/storage-incentives`, pinned submodule) freshly deployed at their mainnet addresses with their AccessControl role wiring and an initial oracle price, and 100 xDAI + 10 BZZ on each Bee node EOA. Anvil starts in <1s. The baked snapshot seeds a `blockchain` named volume on first boot, and anvil's `--state` flag loads from / dumps to that volume — so chain state (stamps purchased, transactions sent) survives `stop`/`start` and matches the persistent Bee node volumes. Use `--rm` / `--fresh` to wipe the volume back to the baked snapshot.

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
- Foundry image used by the bake — `FOUNDRY_IMAGE` env var (default `ghcr.io/foundry-rs/foundry:stable`). The upstream it forks — `GNOSIS_RPC_URL` (default `https://rpc.gnosischain.com`).
- Stamp parameters — `./scripts/buy-stamp.sh <amount> <depth>`. Defaults to `500000000` / depth `20`. The amount must be strictly greater than `oracle.price * minValidityBlocks` (24000 × 17280 = 414 720 000) — see Gotchas in [CLAUDE.md](./CLAUDE.md).

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

## How the pre-funding works

`bee/data/{queen,worker-N}/keys/` holds deterministic libp2p / swarm / pss keys. The queen + worker-1..4 keys come from [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play); worker-5..8 are generated locally by `scripts/generate-identities.sh`. The bake reads the Ethereum address out of every `swarm.key` keystore and funds it with 100 xDAI for gas plus 10 BZZ for the node's own postage purchases. So on first boot Bee reads its baked keys, sees its account has gas, and reaches `synced`.

Don't change the keys without re-baking (`pnpm bake`) — the EOA addresses are paired with the snapshot.

## Bumping the contract submodule

```bash
git -C blockchain/deploy/lib/storage-incentives fetch --tags
git -C blockchain/deploy/lib/storage-incentives checkout v0.9.5     # for example
git add blockchain/deploy/lib/storage-incentives                    # record the new SHA
pnpm bake && docker compose build blockchain
```

The addresses do not move — they come from the deployer/nonce pair, not from the bytecode — but the bake asserts that and fails loudly if one lands elsewhere. Check the constructor signatures still match `blockchain/bake/deploy-swarm.ts` before trusting a bump. Day-to-day workflows (`up`, `down`, `fresh.sh`) don't touch this path.

## Developing the CLI

```bash
pnpm install        # install dev deps
pnpm build          # compile TS to dist/
pnpm dev            # watch mode
node bin/bee-compose.js start --light 2      # run locally without `pnpm link`
```

The `compose.yml`, Dockerfiles, baked Anvil state, and dev identities are all bundled into the published tarball (`pnpm pack` to inspect). The bake tooling and the submodules under `blockchain/deploy/lib/` are excluded — re-baking only works from a git checkout.

## Prior art

- [`@fairdatasociety/fdp-play`](https://github.com/fairDataSociety/fdp-play) — the upstream "Bee + chain in a box" CLI. `bee-compose` is a compose-native take on the same idea: a `compose.yml` is the source of truth, the chain is Anvil booted from a snapshot that borrows Gnosis mainnet's BZZ market and deploys the Swarm contracts from upstream Solidity sources on top (no upstream geth image at any point), and there's a thin Node CLI (`@snaha/bee-compose`) that wraps `docker compose` for cross-platform UX. The queen + worker-1..4 dev identities still come from fdp-play; worker-5..8 are generated locally by `scripts/generate-identities.sh`.

## License

[Apache 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution of bundled upstream assets (Swarm Bee base image, Foundry/Anvil base image, fdp-play dev identities, `ethersphere/storage-incentives` Solidity sources).
