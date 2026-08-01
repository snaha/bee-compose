# Task: build the hybrid local chain for bee-compose

## Mission

Make bee-compose's local chain support **buying postage the way the product
buys it** — swap xDAI for BZZ on a DEX, then `createBatch` — while keeping the
postage side deterministic. The chain must work **offline** and stay reliable
across many purchases.

The design is settled and its risky mechanisms are already proven. Your job is
the wiring, plus the verification that the old failure mode is gone.

## Where things are

- **swarm-id**: branch `feat/onchain-drive-payments` (PR #511, draft).
  Contains `multichain/` — an in-repo package (vendored from
  `@upcoming/multichain-library`) with the Gnosis-side machinery: swap,
  approve, `createBatch`, `topUp`, `increaseDepth`, batch reads, waiters, plus
  `src/dev.ts` (anvil cheats, `simulateWidgetPurchase`).
- **bee-compose**: a git submodule at `vendor/bee-compose`, branch
  `feat/gnosis-chain-profile`. **Read `blockchain/HYBRID-CHAIN.md` first** — it
  is the design doc for this task. Also read its `CLAUDE.md`.
- Chain fixtures/scripts today: `multichain/scripts/bake.sh` +
  `bake-fork-state.ts` (bakes a chain snapshot from a mainnet fork),
  `multichain/test/fixtures/gnosis-fork-state.json`.

## Why this design (two approaches that failed)

1. **Everything deployed from source** (bee-compose's original chain,
   `blockchain/deploy/`): deterministic Swarm contracts, empty batch tree — but
   no DEX and no BZZ market, so the purchase path can't run at all.
2. **A snapshot of Gnosis mainnet**: real DEX and real contracts, but
   `PostageStamp.createBatch` internally walks a red-black tree of *every batch
   on the chain*, and an anvil state dump only keeps storage that something
   actually wrote to. The traversal eventually reaches a node that isn't there
   and reverts `BatchDoesNotExist()` (`0x4ee9bc0f`). Purchases work for a while
   after a volume reset and then fail permanently. Not amount-dependent — both
   a minimal and a large batch reverted identically.

**The hybrid**: take from mainnet only what is hard to deploy (BZZ token,
SushiSwap router/quoter/pool, WXDAI); deploy the four Swarm contracts fresh on
top, at their mainnet addresses, so the batch tree starts empty.

## What is already proven (do not re-litigate)

**A DEX-only warmup keeps the Swarm contracts out of the snapshot entirely.**
Verified: forking mainnet and performing only swaps produced a 22-account,
181 KB dump containing BZZ, WXDAI, the Sushi router and the BZZ/WXDAI pool
(`0x7583b9c573fa4fb5ea21c83454939c4cf6aacbc3`) and **none** of PostageStamp,
PriceOracle, StakeRegistry or Redistribution. So there is nothing to delete —
just never touch them while baking. Their addresses load empty, which is
exactly what the fresh deploy needs (no code, no leftover storage).

**Fresh contracts can be deployed at their mainnet addresses.** A CREATE
address is `keccak(rlp([deployer, nonce]))`, and anvil can impersonate any
account and set its nonce, so deploying as a contract's *original* deployer at
its *original* nonce reproduces the address exactly. Verified end to end
against a throwaway contract:

```
anvil_setBalance          <deployer> <gas>
anvil_setNonce            <deployer> <original nonce>
anvil_impersonateAccount  <deployer>
eth_sendTransaction { from: <deployer>, data: <initCode ++ constructorArgs> }
```

The resulting address matched viem's `getContractAddress` prediction.

**Deployer and nonce are recoverable** from the creation transaction:
`https://gnosis.blockscout.com/api/v2/addresses/<addr>` gives
`creator_address_hash` and `creation_transaction_hash`; then
`eth_getTransactionByHash` on `https://rpc.gnosischain.com` gives the nonce.

**All four are already looked up and verified** (every one deployed by the same
EOA `0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA`, so deploy them in nonce
order). Two of the four had the address derivation independently recomputed
from `keccak(rlp([deployer, nonce]))` and matched.

| Contract | Address | Nonce | Constructor args (mainnet's) |
| --- | --- | --- | --- |
| PostageStamp | `0x45a1502382541Cd610CC9068e88727426b696293` | 6891 | `_bzzToken=0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`, `_minimumBucketDepth=16` |
| PriceOracle | `0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b` | 7039 | `_postageStamp=0x45a1…6293` |
| StakeRegistry | `0xda2a16EE889E7F04980A8d597b48c8D51B9518F4` | 7059 | `_bzzToken=0xdBF3…F68da`, `_NetworkId=1`, `_oracleContract=0x47Ee…0a8b` |
| Redistribution | `0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d` | 7070 | `staking=0xda2a…18F4`, `postageContract=0x45a1…6293`, `oracleContract=0x47Ee…0a8b` |

All four verify as solc `0.8.19+commit.7dd6d404`, optimizer on, 1000 runs, EVM
paris. Deployed source matches `ethersphere/storage-incentives` around
`v0.6.0` (PostageStamp) through `v0.9.3` (StakeRegistry, Redistribution) —
`blockchain/deploy/lib/storage-incentives` is currently pinned at `v0.9.4`,
which is close enough that its addresses/ABIs line up, but check the
constructor signatures still match before assuming.

**A CREATE address depends only on deployer and nonce, not on the constructor
arguments** — so you are free to deploy with args that suit the local cluster
while still landing on the mainnet addresses. Concretely: mainnet's
StakeRegistry took `_NetworkId=1` (the real Swarm network), whereas this
cluster runs `BEE_NETWORK_ID=4020`. Prefer 4020 so staking is coherent with the
nodes.

## Steps

1. **Bake a DEX-only snapshot.** Adapt the existing bake so the warmup performs
   *only* swaps — across a range of sizes, because a swap only warms the ticks
   it crosses and a later trade of a different size would reach for slots that
   were never fetched. Keep the existing step that splices back contracts which
   are only ever *read* (a dump drops them): the **SushiSwap quoter**
   `0xb1E835Dc2785b52265711e17fCCb0fd018226a6e` is required, or every quote
   returns no data. Fund the nine Bee node EOAs with xDAI (addresses come from
   `bee/data/*/keys/swarm.key` — the `address` field of each keystore).
   Land the result at `bee-compose/blockchain/state.gnosis.json` (or rename as
   you see fit) and keep the bake script with it — baking belongs in bee-compose
   now that it owns the only chain.

2. **Deploy the Swarm contracts on boot, at their mainnet addresses.**
   `blockchain/deploy/` (Foundry, storage-incentives pinned) is restored and
   still builds the contracts. Note a plain `forge script` broadcast will NOT
   work: it deploys from one sender at its natural nonce. You need to send the
   deploy transactions yourself — compiled artifacts from `forge build`,
   constructor args encoded, addresses forced with the impersonation mechanism
   above — then assert each resulting address equals the mainnet one and fail
   loudly if not. Afterwards wire the role grants and the initial oracle price
   exactly as `deploy/script/Deploy.s.sol` does today.
   Whether this runs at bake time (dumped into the snapshot) or as an init step
   on container start is your call; baking it in makes startup fast and keeps
   the runtime simple.

3. **Point the nodes at those addresses.** `compose.yml` currently hardcodes the
   mainnet addresses in `x-bee-env` — correct if step 2 hits them. If you end up
   accepting different addresses, restore the `${VAR:-default}` indirection that
   existed at commit `cab6858`.

4. **Verify.** The bar is the failure this design exists to remove:
   - `createBatch` **repeatedly** on a long-lived chain — at least 10 purchases
     without a volume reset. The old chain worked for a few and then reverted
     `BatchDoesNotExist()` forever; that must not recur.
   - Then the product flows from swarm-id, which already exist:
     `CHAIN_RPC_URL=http://localhost:9545 pnpm --filter @swarm-id/ui exec playwright test tests/drive-onchain.test.ts tests/drive-simulated-purchase.test.ts`
     (account creation, purchase paying xDAI, extend, resize, interrupt-and-resume).
   - `pnpm --filter @swarm-id/multichain test:fork` against the same chain.
   - Finally an upload: buy a batch, then upload a chunk stamped client-side by
     the batch owner and read it back. This needs **peers** — a single node
     cannot pushsync a receipt, so bring up workers (`scripts/workers-up.sh`).
     `ui/tests/gnosis-cluster.test.ts` covers the ingestion half already.

## Gotchas that will otherwise cost you hours

- **Bee synthesises an outpayment baseline** of roughly `price × block height`
  when it has no chain history. On a snapshot at block ~47.5M that is ~1.14e12
  per chunk, and any batch funded below it is written off as `low balance
  batch` and ignored by every node. With freshly deployed contracts the chain's
  block height and the oracle's price are yours to choose, so this may
  disappear — **check it rather than assume**, and if it persists, fund dev
  batches above the baseline (swarm-id's `ui/src/lib/dev/chain-funding.ts` has
  `DEV_GNOSIS_AMOUNT_PER_CHUNK` for exactly this).
- **Read-only contracts vanish from a dump.** Anything the warmup only *calls*
  is absent on reload. Bee dies at boot if the staking contract answers with no
  code; every swap quote fails if the Sushi quoter is missing.
- **Non-deferred uploads need peers.** Bee's pushsync only returns a receipt
  when it can reach another node; bee-compose's image already recompiles Bee
  with `reachabilityOverridePublic=true` for this, but you still need >1 node.
- **Switching chain state requires `down -v`.** The chain volume holds whatever
  snapshot seeded it.
- **The BZZ pool is thin** (~$10k). Large swaps move the price; keep test trades
  small and expect a long-lived chain to drift.
- **`pnpm install` inside `vendor/bee-compose`** picks up swarm-id's workspace
  and fails; use `pnpm install --ignore-workspace` there.

## Conventions

Both repos have `CLAUDE.md`/`AGENTS.md` — follow them. Highlights: conventional
commits, no semicolons, `pnpm check:all` must pass in swarm-id, comments explain
*why* not *what*, and never `any`/`null`. bee-compose's rule that matters most:
**`compose.yml` is the source of truth** — anything expressible as compose env
vars belongs there, not in the TS CLI.

Work on the existing branches (`feat/gnosis-chain-profile` in bee-compose,
`feat/onchain-drive-payments` in swarm-id) and keep the submodule pin updated.
