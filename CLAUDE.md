# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster (1 queen + up to 8 workers, each independently full or light) against an Anvil dev chain that's pre-loaded with deployed Swarm contracts. There is **no application code** in the cluster itself — the orchestrated stack is `compose.yml`, two thin Dockerfiles (bee, blockchain), a baked Anvil state snapshot, a Foundry project under `blockchain/deploy/` that produces that snapshot from upstream Solidity sources, pre-generated dev identities, and a handful of shell scripts.

On top of that there's a thin Node CLI under `src/` (published as `@snaha/bee-compose`) that wraps `docker compose` for cross-platform UX. The CLI and the shell scripts both target the same `compose.yml` — `compose.yml` is the source of truth; nothing important lives in TypeScript.

## Common commands

Three equivalent ways to drive the stack — all hit the same `compose.yml`. Pick whichever the user is using and stay consistent.

**Node CLI** (cross-platform, `pnpm`-managed; the published interface):

```bash
pnpm install && pnpm build              # one-time: compile TS to dist/
node bin/bee-compose.js start                            # queen only (default: --full 1 --light 0)
node bin/bee-compose.js start --light 4                  # queen + 4 light workers
node bin/bee-compose.js start --full 3 --light 2         # queen + 2 full workers + 2 light workers
node bin/bee-compose.js start --full 9                   # queen + 8 full workers (max)
node bin/bee-compose.js start --light 2 --pull --fresh   # queen + 2 light workers, nuke + refresh first
node bin/bee-compose.js stamp           # buy a postage stamp on the queen
node bin/bee-compose.js logs queen -f
node bin/bee-compose.js stop --rm       # full teardown (down -v)
node bin/bee-compose.js redeploy        # regenerate state.anvil.json (git checkout only)
```

**Shell scripts** (the original no-Node path, Linux/macOS):

```bash
docker compose up -d                    # queen + chain (workers are behind the `workers` profile)
./scripts/workers-up.sh                 # add workers (resolves queen peer id, exports QUEEN_BOOTNODE)
./scripts/buy-stamp.sh [amount] [depth] # default 500000000 / 20
./scripts/fresh.sh                      # down -v, rebuild --pull, up queen
./scripts/redeploy-contracts.sh         # regenerate state.anvil.json from source
```

**Raw compose** (for surgical operations):

```bash
docker compose build                                # rebuild all images
BEE_VERSION=2.8.0 docker compose build              # override pinned bee version
FOUNDRY_VERSION=v1.5.1 docker compose build blockchain
docker compose --profile workers ps                 # see all services incl. defined-but-not-running workers
```

APIs: queen `http://127.0.0.1:1633`, worker-N `http://127.0.0.1:1633{N}` for N in 1..8 (so worker-1 is `:16331`, worker-8 is `:16338`). Chain RPC `:9545`.

## Architecture

**Three Dockerfiles, three roles, all baked.** Each service builds its own tagged image and copies its role-specific assets at build time:

- `bee/Dockerfile` — multi-stage: a `golang` builder clones `ethersphere/bee` at `v${BEE_VERSION}` and runs `make binary REACHABILITY_OVERRIDE_PUBLIC=true` (recompiles bee with `reachabilityOverridePublic=true` — see Gotchas for why), then the final stage starts `FROM ethersphere/bee:${BEE_VERSION}`, overwrites `/usr/local/bin/bee` with the recompiled binary, takes a `ROLE` arg (`queen` | `worker-N`), and `COPY`s `data/${ROLE}/` into `/home/bee/.bee/`. Each Bee service builds its own image (`bee-compose:queen-<ver>`, `bee-compose:worker-N-<ver>`); the builder stage depends only on `BEE_VERSION`, so BuildKit compiles bee once and reuses that layer across all 9 images.
- `blockchain/Dockerfile` — `FROM ghcr.io/foundry-rs/foundry:${FOUNDRY_VERSION}`, copies `blockchain/state.anvil.json` into `/state.anvil.json` and a small entrypoint script into `/entrypoint.sh`. On first boot the script seeds `/data/state.anvil.json` from the baked snapshot, then execs `anvil --state /data/state.anvil.json --state-interval 30` with chain-id 4020 and a 5s block time. `--state` makes anvil both load from and dump to that path on graceful shutdown; `--state-interval` adds periodic dumps to bound loss from non-graceful kills.
- Runtime Bee state lives in named volumes (`queen`, `worker-N`). The blockchain also has its own `blockchain` volume mounted at `/data`, so chain state (stamps purchased, transactions sent) survives `docker compose restart` / `stop` / `start`. The baked snapshot in the image is only used to seed an empty volume on first boot. Tearing the volume down (`down -v`, `bee-compose stop --rm`, `fresh.sh`) resets the chain to the baked snapshot.

**The Anvil snapshot is the single source of truth for chain state at runtime.** `blockchain/state.anvil.json` is plain JSON (~660 KB) regenerated by `scripts/redeploy-contracts.sh`. It contains:

- The 6 deployed Swarm contracts (BZZ TestToken, PostageStamp, PriceOracle, StakeRegistry, Redistribution, SimpleSwapFactory) with full bytecode and storage.
- 1 helper contract — the ERC20SimpleSwap master that the factory clones for every chequebook.
- The 9 Bee node EOAs (queen + worker-1..8) derived from the baked swarm keys, each pre-funded with 100 ETH (gas) + 100 000 BZZ (chequebook + stamps).
- All AccessControl role grants (PRICE_ORACLE_ROLE, REDISTRIBUTOR_ROLE, PRICE_UPDATER_ROLE) wired to the right contracts so the postage / oracle / redistribution stack is fully active out of the box.
- An initial price seed on the oracle so the postage stamp's "is this batch usable" math has a real number to compare against.

The contract addresses pinned in `compose.yml`'s `x-bee-env` YAML anchor are produced by the deploy script and are stable across reruns: deployer EOA is fixed (Anvil's well-known account[0]), every redeploy starts from a fresh chain at nonce 0, and the Solidity submodules are tag-pinned. **Bumping a contract submodule re-derives addresses** — the script prints them at the end of every run; update `x-bee-env` to match.

**The Foundry project under `blockchain/deploy/`** is the source of truth for chain state. Layout:

- `script/Deploy.s.sol` — single Solidity script that deploys + wires + funds, in a fixed order.
- `src/CompileFactory.sol` — solc-0.7.6 stub that imports `SimpleSwapFactory` from the swap-swear submodule. Its only job is to drag the 0.7.6 contract into the build graph; the deploy script can't import it directly because solc forbids cross-version imports, so we use `vm.getCode(...)` + assembly `create` instead.
- `lib/` — git submodules pinned to specific tags:
  - `forge-std@v1.16.0`
  - `openzeppelin-contracts@v4.8.3` (used by storage-incentives, solc 0.8.x)
  - `openzeppelin-contracts-v3-solc-0.7@v3.4.2-solc-0.7` (used by swap-swear, solc 0.7.6)
  - `storage-incentives@v0.9.4` (PostageStamp, PriceOracle, Staking, Redistribution, TestToken)
  - `swap-swear-and-swindle@v0.6.9` (SimpleSwapFactory, ERC20SimpleSwap)
- `remappings.txt` — path-scoped remappings so storage-incentives' `@openzeppelin/contracts/...` imports resolve to OZ 4.8.3 while swap-swear's same-named imports resolve to OZ 3.4.2-solc-0.7. `auto_detect_remappings = false` in `foundry.toml` because Foundry's auto-detection conflicts with the dual-OZ setup if any nested submodule clones bring their own `lib/` trees in.

**Determinism details.** The deploy script uses plain `CREATE` (sequential nonces from a fixed deployer key), not `CREATE2`. Reasoning: when Foundry routes `new Contract{salt: ...}(args)` through the canonical CREATE2 deployer at `0x4e59…b44`, `msg.sender` inside the constructor becomes that proxy — so AccessControl-derived contracts grant `DEFAULT_ADMIN_ROLE` to the proxy, not to our EOA, and we can't wire up roles afterwards. With plain CREATE the EOA is the constructor caller, holds admin, and grants roles in the same broadcast.

**Why deploy from source instead of baking upstream chaindata?** The previous incarnation rebaked from `fairdatasociety/fdp-play-blockchain` by replaying signed transactions. That worked but bound us to fdp-play's release cadence and gave no control over which contract version was deployed. With our own deploy:

- We pin Solidity tags directly (`storage-incentives@v0.9.4`, `swap-swear-and-swindle@v0.6.9`) and bump them independently.
- The deployer key is Anvil's account[0], not an opaque upstream EOA.
- Role grants and the oracle's initial price are part of the deploy, so the chain comes up fully active — no half-initialized state.
- `redeploy-contracts.sh` has no upstream image dependency; it only needs `ghcr.io/foundry-rs/foundry:stable`.

**Role baked into the image, not mounted.** Re-emphasizing because it bites: `bee/Dockerfile` `COPY`s identity at build time. Editing `bee/data/` requires rebuilding the affected service's image (`docker compose build queen` or `... worker-N`).

**Pre-funded identities are paired with the deploy.** `bee/data/{queen,worker-N}/keys/` holds deterministic libp2p_v2 / swarm / pss keys. The queen + worker-1..4 keys originally came from `@fairdatasociety/fdp-play`; worker-5..8 were generated by `scripts/generate-identities.sh` (which spins up a throwaway bee container per identity, lets bee write its own keys, captures the EOA from logs, copies keys out). The Ethereum addresses Bee derives from those `swarm.key` files are hardcoded in `Deploy.s.sol`'s `_beeNodes()` (a 9-element array) — they each get 100 ETH + 100 000 BZZ during the deploy. **Changing keys requires updating `_beeNodes()` and rerunning the deploy** (which is what `bee-compose redeploy` / `scripts/redeploy-contracts.sh` does).

**Adding more workers beyond 8** is intentionally manual: run `scripts/generate-identities.sh 9 N`, paste the printed EOAs into `_beeNodes()` (bumping the array size), `bee-compose redeploy`, then add service blocks to `compose.yml` and bump `MAX_WORKERS` in `src/commands/start.ts` + `VALID_SERVICES` in `src/commands/logs.ts`. Worker port scheme `1633{N}` only works up to N=9; past that pick a new scheme. If this becomes a frequent operation, the right move is the runtime-mounted-identities refactor (one bee image, identities mounted at start time, compose.yml generated from a template) — currently rejected to keep the "everything is baked" property intact.

**Light vs full workers** is a per-worker env var (`BEE_WORKER_N_FULL`, default `false`) consumed by each worker service's `BEE_FULL_NODE`. The queen is hardcoded to `BEE_FULL_NODE: "true"` in compose.yml — it's always full and always running.

The CLI's `--full F --light L` semantics: **`--full` counts ALL full nodes including the queen**, so `--full 1` = queen only, `--full 3` = queen + 2 full workers. The number of full *workers* is `F - 1`. Allocation: workers `1..(F-1)` are full, workers `F..(F-1+L)` are light. The queen always counts as one of the full nodes, which keeps `--full` semantics consistent ("I want N total full nodes") and avoids "queen is special, ignore it" caveats. Re-running with the same `--full` count is stable — a given worker doesn't switch types unless `--full` changes.

**Worker bootstrap is dynamic.** `scripts/workers-up.sh` curls `http://127.0.0.1:1633/addresses`, extracts the queen's peer id from `underlay`, and exports `QUEEN_BOOTNODE=/dns4/queen/tcp/1634/p2p/<peer-id>` before `docker compose --profile workers up -d`. DNS name (`queen`) is used instead of an IP so it survives container recreates; peer id is stable because it's derived from the baked libp2p key. The worker YAML anchor (`x-worker`) reads `${QUEEN_BOOTNODE:-}` — running `docker compose --profile workers up` without the script leaves workers with no bootnode.

**Workers are opt-in via profile.** `profiles: ["workers"]` on each worker service means plain `docker compose up` only starts `blockchain` + `queen`. Any command that should touch workers (including `down -v`) needs `--profile workers` — see `fresh.sh`.

**The Node CLI is a thin wrapper, not a reimplementation.** `src/` has six subcommands (`start`, `stop`, `logs`, `stamp`, `status`, `redeploy`); each one builds an argv and spawns `docker compose -f <packageRoot>/compose.yml ...` with stdio inherited. All compose paths resolve from `__dirname` so `pnpm dlx @snaha/bee-compose start` works from any cwd. The compose.yml inside the published tarball is the same one in the repo; image tags / contract addresses / port mappings all flow from there. Worker bootstrap re-implements `workers-up.sh` in TS using `fetch` against `/addresses` (no shell, no python). `redeploy` re-implements `redeploy-contracts.sh` using `child_process.spawn` to `git`/`docker` plus Node's `zlib.gunzip` — works on Windows because it uses a user-defined docker network instead of `--network host`. **Don't add features that diverge the CLI from the compose.yml** — anything that can be expressed as compose env vars or service selection should be, so the shell-script and CLI paths stay equivalent.

## Gotchas

- **Bee is recompiled with `reachabilityOverridePublic=true`.** The stock `ethersphere/bee` image ships this build-time ldflag OFF, and it is *not* overridable by any `BEE_*` env var. With it off, libp2p AutoNAT never confirms reachability on the docker bridge network, so each node's own reachability stays `Unknown`; bee's pushsync only stores + returns a receipt when `IsReachable()` is true, so **non-deferred uploads (`deferred:false`, all SOC/feed writes) hang ~30s and never replicate**. `bee/Dockerfile` therefore recompiles bee from source at `v${BEE_VERSION}` with the override on (see issue #11). Consequences: the **first** image build compiles bee from source (slow, a few minutes; cached thereafter and shared across all 9 images). Bumping `BEE_VERSION` recompiles at that tag — if a future bee tag needs a newer Go than the pinned `golang:1.25` builder, bump the builder image too (Go's `GOTOOLCHAIN=auto` usually fetches the go.mod-pinned toolchain automatically).
- **First-boot DNS race.** On a freshly created compose network, queen sometimes fails its first start with `dial tcp: lookup blockchain on ...: network is unreachable`. The `restart: unless-stopped` policy recovers within ~15s. If you're scripting against a clean stack and need determinism, `docker compose up -d --force-recreate` after bringing up the network avoids the race.
- **Stamp amount must be strictly greater than `price * minimumValidityBlocks`.** The on-chain effective price is **24000** (PriceOracle's `minimumPriceUpscaled` floor — `setPrice` silently clamps anything lower; `Deploy.s.sol`'s `INITIAL_PRICE` is set to 24000 to match). With Bee's 17280-block (24h) minimum, the threshold is 414 720 000. `buy-stamp.sh` / `bee-compose stamp` default to 500 000 000 to leave ~21% headroom; passing the threshold or below returns `400 insufficient amount for 24h minimum validity`.
- **Stamp `not usable` on GET, but uploads work.** `GET /stamps/<id>` returns 400 "batch not usable" for ~30s after `buy-stamp.sh`, but `POST /bytes` with that stamp ID succeeds anyway. Bee's `IsUsable` check used by the GET endpoint is more conservative than the upload path.
- **Cross-peer retrieval may 404 without staking.** A chunk uploaded on the queen retrieves fine on the queen but may not retrieve via worker-N until kademlia topology stabilizes and stakes are placed. This is Swarm storage-incentives behavior, unrelated to the blockchain backend.
