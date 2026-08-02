# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Docker Compose stack for running a local [Swarm](https://www.ethswarm.org/) Bee cluster (1 queen + up to 8 workers, each independently full or light) against an Anvil chain seeded from a **hybrid snapshot** — Gnosis mainnet's BZZ token and SushiSwap pools, with the Swarm contracts deployed from source on top at their mainnet addresses — so postage can be bought the way a product buys it, with no internet. There is **no application code** in the cluster itself — the orchestrated stack is `compose.yml`, two thin Dockerfiles (bee, blockchain), the baked chain snapshot, pre-generated dev identities, and a handful of shell scripts.

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
```

**Shell scripts** (the original no-Node path, Linux/macOS):

```bash
docker compose up -d                    # queen + chain (workers are behind the `workers` profile)
./scripts/workers-up.sh                 # add workers (resolves queen peer id, exports QUEEN_BOOTNODE)
./scripts/buy-stamp.sh [amount] [depth] # default 500000000 / 20
./scripts/fresh.sh                      # down -v, rebuild --pull, up queen
```

**Raw compose** (for surgical operations):

```bash
docker compose build                                # rebuild all images
BEE_VERSION=2.8.0 docker compose build              # override pinned bee version
FOUNDRY_VERSION=v1.5.1 docker compose build blockchain
docker compose --profile workers ps                 # see all services incl. defined-but-not-running workers
```

**Chain tooling.** Needs `pnpm install --ignore-workspace` first — a plain `pnpm install` picks up the parent workspace when this repo is vendored inside one, and fails.

```bash
pnpm bake                                           # re-bake blockchain/state.gnosis.json (NEEDS INTERNET)
pnpm verify:chain                                   # buy postage repeatedly against a running cluster
```

APIs: queen `http://127.0.0.1:1633`, worker-N `http://127.0.0.1:1633{N}` for N in 1..8 (so worker-1 is `:16331`, worker-8 is `:16338`). Chain RPC `:9545`.

## Architecture

**Three Dockerfiles, three roles, all baked.** Each service builds its own tagged image and copies its role-specific assets at build time:

- `bee/Dockerfile` — multi-stage: a `golang` builder clones `ethersphere/bee` at `v${BEE_VERSION}` and runs `make binary REACHABILITY_OVERRIDE_PUBLIC=true` (recompiles bee with `reachabilityOverridePublic=true` — see Gotchas for why), then the final stage starts `FROM ethersphere/bee:${BEE_VERSION}`, overwrites `/usr/local/bin/bee` with the recompiled binary, takes a `ROLE` arg (`queen` | `worker-N`), and `COPY`s `data/${ROLE}/` into `/home/bee/.bee/`. Each Bee service builds its own image (`bee-compose:queen-<ver>`, `bee-compose:worker-N-<ver>`); the builder stage depends only on `BEE_VERSION`, so BuildKit compiles bee once and reuses that layer across all 9 images.
- `blockchain/Dockerfile` — `FROM ghcr.io/foundry-rs/foundry:${FOUNDRY_VERSION}`, copies `blockchain/state.gnosis.json` into `/state.gnosis.json` and a small entrypoint script into `/entrypoint.sh`. On first boot the script seeds `/data/state.anvil.json` from the baked snapshot, then execs `anvil --state /data/state.anvil.json --state-interval 30` with chain-id 100 and a 5s block time. `--state` makes anvil both load from and dump to that path on graceful shutdown; `--state-interval` adds periodic dumps to bound loss from non-graceful kills.
- Runtime Bee state lives in named volumes (`queen`, `worker-N`). The blockchain also has its own `blockchain` volume mounted at `/data`, so chain state (stamps purchased, transactions sent) survives `docker compose restart` / `stop` / `start`. The baked snapshot in the image is only used to seed an empty volume on first boot. Tearing the volume down (`down -v`, `bee-compose stop --rm`, `fresh.sh`) resets the chain to the baked snapshot.

**The Anvil snapshot is the single source of truth for chain state at runtime.** `blockchain/state.gnosis.json` is plain JSON (~800 KB): the BZZ token, WXDAI and the SushiSwap router / quoter / BZZ pool borrowed from a Gnosis mainnet fork, plus PostageStamp / PriceOracle / StakeRegistry / Redistribution **deployed from source** onto their mainnet addresses, and the 9 Bee node EOAs pre-funded with xDAI for gas.

Baking is `blockchain/bake/bake.sh` (`pnpm bake`), in three stages, and the split is load-bearing — see `blockchain/HYBRID-CHAIN.md`. Briefly: a fork fetches state lazily and a dump keeps only accounts something *wrote* to, so stage 1 warms the DEX with real trades and touches nothing else (which is what leaves the four Swarm addresses empty); stage 2 deploys into those empty addresses on a **plain** anvil loaded with that dump, forcing each address by impersonating the original deployer at its original nonce; stage 3 splices back the contracts a dump drops (the Sushi quoter, which is only ever *read*) and asserts the result is whole.

**Role baked into the image, not mounted.** Re-emphasizing because it bites: `bee/Dockerfile` `COPY`s identity at build time. Editing `bee/data/` requires rebuilding the affected service's image (`docker compose build queen` or `... worker-N`).

**Pre-funded identities are paired with the deploy.** `bee/data/{queen,worker-N}/keys/` holds deterministic libp2p_v2 / swarm / pss keys. The queen + worker-1..4 keys originally came from `@fairdatasociety/fdp-play`; worker-5..8 were generated by `scripts/generate-identities.sh` (which spins up a throwaway bee container per identity, lets bee write its own keys, captures the EOA from logs, copies keys out). The Ethereum addresses Bee derives from those `swarm.key` files are funded with xDAI directly in the chain snapshot. **Changing keys requires re-baking the snapshot** with the new addresses funded.

**Adding more workers beyond 8** is intentionally manual: run `scripts/generate-identities.sh 9 N`, fund the printed EOAs when re-baking the snapshot, then add service blocks to `compose.yml` and bump `MAX_WORKERS` in `src/commands/start.ts` + `VALID_SERVICES` in `src/commands/logs.ts`. Worker port scheme `1633{N}` only works up to N=9; past that pick a new scheme. If this becomes a frequent operation, the right move is the runtime-mounted-identities refactor (one bee image, identities mounted at start time, compose.yml generated from a template) — currently rejected to keep the "everything is baked" property intact.

**Light vs full workers** is a per-worker env var (`BEE_WORKER_N_FULL`, default `false`) consumed by each worker service's `BEE_FULL_NODE`. The queen is hardcoded to `BEE_FULL_NODE: "true"` in compose.yml — it's always full and always running.

The CLI's `--full F --light L` semantics: **`--full` counts ALL full nodes including the queen**, so `--full 1` = queen only, `--full 3` = queen + 2 full workers. The number of full *workers* is `F - 1`. Allocation: workers `1..(F-1)` are full, workers `F..(F-1+L)` are light. The queen always counts as one of the full nodes, which keeps `--full` semantics consistent ("I want N total full nodes") and avoids "queen is special, ignore it" caveats. Re-running with the same `--full` count is stable — a given worker doesn't switch types unless `--full` changes.

**Worker bootstrap is dynamic.** `scripts/workers-up.sh` curls `http://127.0.0.1:1633/addresses`, extracts the queen's peer id from `underlay`, and exports `QUEEN_BOOTNODE=/dns4/queen/tcp/1634/p2p/<peer-id>` before `docker compose --profile workers up -d`. DNS name (`queen`) is used instead of an IP so it survives container recreates; peer id is stable because it's derived from the baked libp2p key. The worker YAML anchor (`x-worker`) reads `${QUEEN_BOOTNODE:-}` — running `docker compose --profile workers up` without the script leaves workers with no bootnode.

**Workers are opt-in via profile.** `profiles: ["workers"]` on each worker service means plain `docker compose up` only starts `blockchain` + `queen`. Any command that should touch workers (including `down -v`) needs `--profile workers` — see `fresh.sh`.

**The Node CLI is a thin wrapper, not a reimplementation.** `src/` has five subcommands (`start`, `stop`, `logs`, `stamp`, `status`); each one builds an argv and spawns `docker compose -f <packageRoot>/compose.yml ...` with stdio inherited. All compose paths resolve from `__dirname` so `pnpm dlx @snaha/bee-compose start` works from any cwd. The compose.yml inside the published tarball is the same one in the repo; image tags / contract addresses / port mappings all flow from there. Worker bootstrap re-implements `workers-up.sh` in TS using `fetch` against `/addresses` (no shell, no python). **Don't add features that diverge the CLI from the compose.yml** — anything that can be expressed as compose env vars or service selection should be, so the shell-script and CLI paths stay equivalent.

## The chain

`blockchain/state.gnosis.json` is the hybrid snapshot; the entrypoint seeds the
volume from it and runs anvil with `--chain-id 100`. The nodes are pointed at
the Gnosis mainnet contract addresses in `compose.yml` because that is where
the bake puts the freshly deployed contracts — so postage bought via a DEX swap
+ `createBatch` is usable here, which is the whole point.

`blockchain/deploy/` is a Foundry project that only **compiles** the contracts
(`ethersphere/storage-incentives`, pinned submodule). There is no deploy script:
`forge script` broadcasts from one sender at its natural nonce, and these have
to land on specific addresses, so `blockchain/bake/deploy-swarm.ts` sends the
deploy transactions itself. `redeploy-contracts.sh` and the `redeploy` CLI
command are gone — they built the old chain, which had no DEX.

The design and its two verified mechanisms are in `blockchain/HYBRID-CHAIN.md`.
Read it before changing anything about how the snapshot is produced; the
staging is not incidental.

**Do not go back to a plain mainnet dump.** `createBatch` walks a red-black tree
of every batch on the chain, a dump keeps only storage something touched, and
the traversal eventually reverts `BatchDoesNotExist()` (`0x4ee9bc0f`) — for
good, on any amount. `pnpm verify:chain` is the regression check.

## Gotchas

- **Bee is recompiled with `reachabilityOverridePublic=true`.** The stock `ethersphere/bee` image ships this build-time ldflag OFF, and it is *not* overridable by any `BEE_*` env var. With it off, libp2p AutoNAT never confirms reachability on the docker bridge network, so each node's own reachability stays `Unknown`; bee's pushsync only stores + returns a receipt when `IsReachable()` is true, so **non-deferred uploads (`deferred:false`, all SOC/feed writes) hang ~30s and never replicate**. `bee/Dockerfile` therefore recompiles bee from source at `v${BEE_VERSION}` with the override on (see issue #11). Consequences: the **first** image build compiles bee from source (slow, a few minutes; cached thereafter and shared across all 9 images). Bumping `BEE_VERSION` recompiles at that tag — if a future bee tag needs a newer Go than the pinned `golang:1.26` builder, bump the builder image too (Go's `GOTOOLCHAIN=auto` usually fetches the go.mod-pinned toolchain automatically).
- **Blockchain RPC endpoint is a CLI flag, not an env var (since bee 2.8.0).** Bee 2.8.0 moved this option to the nested config key `blockchain-rpc.endpoint` and reads it via that dotted key. Bee's viper env-key replacer only maps `-`→`_` (not `.`), so `BEE_BLOCKCHAIN_RPC_ENDPOINT` no longer reaches it — the node boots with an empty endpoint and dies with `init chain: dial blockchain client: dial unix: missing address`. The `x-bee-command` anchor in `compose.yml` therefore passes `--blockchain-rpc-endpoint http://blockchain:9545` as a CLI flag (the pflag is bound to the nested key, so the flag works). The old `--swap-endpoint` (`BEE_SWAP_ENDPOINT`) flag was also removed in 2.8.0; swap reuses this same endpoint. General lesson for future bee bumps: a `BEE_*` env var that silently stops taking effect usually means the option migrated to a nested config key — pass it as a CLI flag.
- **First-boot DNS race.** On a freshly created compose network, queen sometimes fails its first start with `dial tcp: lookup blockchain on ...: network is unreachable`. The `restart: unless-stopped` policy recovers within ~15s. If you're scripting against a clean stack and need determinism, `docker compose up -d --force-recreate` after bringing up the network avoids the race.
- **Stamp amount must be strictly greater than `price * minimumValidityBlocks`.** The on-chain effective price is **24000** (PriceOracle's `minimumPriceUpscaled` floor — `setPrice` silently clamps anything lower; the bake's `INITIAL_PRICE` is set to 24000 to match). With Bee's 17280-block (24h) minimum, the threshold is 414 720 000. `buy-stamp.sh` / `bee-compose stamp` default to 500 000 000 to leave ~21% headroom; passing the threshold or below returns `400 insufficient amount for 24h minimum validity`.
- **Stamp `not usable` on GET, but uploads work.** `GET /stamps/<id>` returns 400 "batch not usable" for ~30s after `buy-stamp.sh`, but `POST /bytes` with that stamp ID succeeds anyway. Bee's `IsUsable` check used by the GET endpoint is more conservative than the upload path.
- **`BEE_POSTAGE_STAMP_START_BLOCK` must be re-synced with every bake.** It is the block PostageStamp was deployed in. Set it *later* and the nodes miss the initial `PriceUpdate` and every `BatchCreated` — batches exist on chain and no node has heard of them, with no error anywhere. `pnpm bake` prints the value to use.
- **Bee's outpayment baseline is no longer a hazard, but it is still a mechanism.** On the old mainnet-dump chain a node synthesised a total-outpayment near `price × block height` (~1.14e12 per chunk) and dismissed anything funded below it as `low balance batch`. With freshly deployed contracts the node learns the price from the bake's own `PriceUpdate` event, so its chain state starts at `totalAmount: 0` and batches funded at the contract floor are accepted. Check `GET /chainstate` before blaming a funding amount.
- **`evm_revert` drags the chain's clock behind wall time, and a node started afterwards will not sync.** Anvil rewinds block timestamps along with the blocks, so a suite that snapshots and reverts (`ui/tests/drive-onchain.test.ts`, `multichain`'s fork tests) leaves the head block as far behind as the suite took to run. Bee then loops on `still waiting for blockchain RPC to sync` forever — the gap is constant, since anvil mines one 5s block per 5 real seconds. Already-running nodes are unaffected. Fix without a reset: `cast rpc evm_setNextBlockTimestamp $(date +%s)` then `cast rpc anvil_mine 0x1`, and restart the stuck node.
- **Cross-peer retrieval may 404 without staking.** A chunk uploaded on the queen retrieves fine on the queen but may not retrieve via worker-N until kademlia topology stabilizes and stakes are placed. This is Swarm storage-incentives behavior, unrelated to the blockchain backend.
