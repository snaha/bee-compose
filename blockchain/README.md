# The chain

The cluster runs on a **hybrid snapshot**: Gnosis mainnet's BZZ market, with the
Swarm contracts deployed from source on top at their mainnet addresses. Built by
`bake/bake.sh` (`pnpm bake` from the repo root), committed as `state.gnosis.json`,
baked into the blockchain image. No internet at runtime.

This is the reference for everything about the chain. Read it before changing
how the snapshot is produced — none of the structure below is incidental.

## Why hybrid

Neither pure approach works:

- **Everything from source** (what this repo did originally) — deterministic
  contracts and an empty batch tree, but no DEX and no BZZ market, so postage
  cannot be bought the way a product buys it (swap xDAI for BZZ, then
  `createBatch`) at all.
- **A plain mainnet dump** — real DEX, real BZZ, but `PostageStamp.createBatch`
  walks a red-black tree of every batch on the chain while a dump keeps only
  storage something *wrote* to. The traversal eventually reaches a node that is
  not there and reverts `BatchDoesNotExist()` (`0x4ee9bc0f`) — permanently, on
  any amount, after a handful of purchases.

So borrow only what cannot be deployed, and deploy the rest fresh:

| Borrowed from mainnet | Deployed from source |
| --- | --- |
| BZZ token, WXDAI, USDC, SushiSwap router / quoter / both BZZ pools / WXDAI-USDC pool | PostageStamp, PriceOracle, StakeRegistry, Redistribution |

Empty batch tree, real liquidity to price against. `pnpm verify:chain` is the
regression bar and the smoke job runs it: buy postage the product's way,
repeatedly, and expect no revert.

## Landing them on their mainnet addresses

An app resolves contract addresses from the chain id, so a chain answering as
Gnosis has to carry the Gnosis deployments.

A CREATE address is `keccak(rlp([deployer, nonce]))` and depends on nothing
else — notably not the constructor arguments, which is why StakeRegistry can
take this cluster's network id (4020) rather than mainnet's and still land
correctly. Anvil can impersonate any account and set its nonce:

```
anvil_setBalance / anvil_setNonce / anvil_impersonateAccount  <original deployer>
eth_sendTransaction { from: <deployer>, data: <initCode ++ args> }
```

All four Swarm contracts came from one EOA,
`0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA`, so they deploy in nonce order.
Every address is asserted; the bake fails loudly if one lands elsewhere.

| Contract | Address | Nonce | Constructor args used here |
| --- | --- | --- | --- |
| PostageStamp | `0x45a1502382541Cd610CC9068e88727426b696293` | 6891 | `_bzzToken=0xdBF3…F68da`, `_minimumBucketDepth=16` |
| PriceOracle | `0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b` | 7039 | `_postageStamp=0x45a1…6293` |
| StakeRegistry | `0xda2a16EE889E7F04980A8d597b48c8D51B9518F4` | 7059 | `_bzzToken=0xdBF3…F68da`, `_NetworkId=4020`, `_oracleContract=0x47Ee…0a8b` |
| Redistribution | `0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d` | 7070 | `staking=0xda2a…18F4`, `postageContract=0x45a1…6293`, `oracleContract=0x47Ee…0a8b` |

To recover a deployer and nonce for another contract:
`gnosis.blockscout.com/api/v2/addresses/<addr>` gives `creator_address_hash` and
`creation_transaction_hash`, then `eth_getTransactionByHash` gives the nonce.

Sources are `ethersphere/storage-incentives` at the pinned submodule, compiled
the way mainnet's own deployments were verified: solc 0.8.19, optimizer on,
1000 runs, EVM paris. `deploy/` **only compiles** — a `forge script` broadcast
deploys from one sender at its natural nonce and so cannot force an address,
which is why `bake/deploy-swarm.ts` sends the transactions itself.

## The three stages

`bake/bake.sh`. The split is the design:

1. **`warm-dex.ts`, against a fork of mainnet.** Trades the real BZZ pools
   across an ascending ladder — a swap only warms the ticks it crosses, so a
   later trade of a different size would reach for slots never fetched — then
   sells the position back, leaving the same ticks warm both ways and the pools
   near their starting price. **Both routes to BZZ are warmed**: the direct
   BZZ/WXDAI pool and the WXDAI→USDC→BZZ path, because the product trades
   through whichever fills better and an offline chain that only knows one of
   them prices purchases differently from production (see the note on pool
   sizes below). Keeps 250 BZZ for the dev faucet, writes its WXDAI and USDC
   floats straight onto the token balances — buying them would move the thin
   pools, see `setTokenBalance` — funds the nine Bee node EOAs, pins read-only
   storage (below), and **touches nothing else**: untouched, the Swarm
   contracts stay out of the dump and their addresses reload empty.
2. **`deploy-swarm.ts`, against a plain anvil loaded with that dump.** Not a
   fork, and that is the point — on a fork those addresses still hold mainnet's
   code and CREATE would refuse, while clearing the code with `anvil_setCode`
   would leave mainnet's storage readable underneath, which is exactly how the
   batch-tree hazard would sneak back in. Deploys, asserts each address, wires
   the roles, sets the initial price, and checks what the reload should have
   preserved.
3. **`finalise.ts`.** Splices back whole contracts a dump drops (below), asserts
   the snapshot is whole, and writes `BEE_POSTAGE_STAMP_START_BLOCK` into
   `compose.yml`.

## What a dump drops, and the two ways back

A fork fetches state lazily and the dump keeps only what something **wrote** to.
So anything the chain must *answer* rather than *execute* goes missing, in two
shapes:

- **A whole contract**, when nothing ever sent it a transaction. The SushiSwap
  quoter is only ever `eth_call`ed, so it reloads with no code and every quote
  comes back empty. `finalise.ts` fetches its code from upstream and splices it
  in — `READ_ONLY_CONTRACTS`.
- **Individual slots** of a contract that *is* present. `BZZ.decimals()`,
  `symbol()`, `name()` and `totalSupply()` read slots the trading never wrote,
  so an early snapshot answered `0` and `""`. A missing slot reads as zero
  rather than reverting, so nothing reports a fault while every consumer formats
  its amounts 1e16 out. `warmReads()` traces the call with `prestateTracer`,
  which reports every slot it touches (through a proxy's delegatecall included),
  and writes each back at the value it already holds — a no-op on chain that
  marks the slot dirty, so it is dumped.

Both are asserted after the reload. That half matters more than the mechanism:
this class of failure is silent by construction, so anything new the chain must
answer without executing needs a check, not just a warm-up.

## Limits

- **Storage incentives do not play.** The nodes hold no stake, so the
  redistribution agent logs `phase failed` every round. Harmless for
  upload/download work.
- **The pools are small, unevenly so, and each is honest only up to the first
  tick the snapshot cannot see.** BZZ has two pools on SushiSwap V3, an order
  of magnitude apart — BZZ/WXDAI holds ~167 WXDAI against ~19 600 BZZ (roughly
  $1.2k), BZZ/USDC ~3 055 USDC against ~142 000 BZZ — which is why both routes
  are warmed (above). Offline nothing ever sells back, so purchases only walk
  the price up, and what bounds each pool is not the ladder that warmed it but
  its tick structure.

  A swap persists the slots it *consults* — the `tickBitmap` words its loop
  scans land in the dump with their true values — but a tick **struct** is
  only touched when a swap actually crosses that tick, and the bake's trades
  never crossed one. So the snapshot holds bitmap words whose bits point at
  ticks whose structs are absent, and past its first initialized tick an
  offline pool "crosses" a real tick as a no-op: no revert, just a curve that
  quietly stops being mainnet's. Which way it bends depends on what the
  missed tick did:

  | pool | first unseen tick | reached after | past it, offline is |
  | --- | --- | --- | --- |
  | BZZ/WXDAI | `33480` (+855e18 liquidity, a 13x step) | ~230 xDAI | pessimistic — less BZZ than mainnet gives |
  | BZZ/USDC | `−256680` (+34% liquidity) | ~770 xDAI | pessimistic |
  | WXDAI/USDC | `276326` (**−20e18 of 22e18**) | ~850 xDAI | **optimistic — quotes depth mainnet loses** |

  Measured against the committed snapshot and live mainnet at head 47 920 562
  (`pool.ticks()` live vs offline, and quoter ladders watching
  `initializedTicksCrossed`); tick structure moves with LPs, so re-measure
  before leaning on the exact numbers. Practically: the routed path that
  carries drive-sized purchases reproduces the fork block's pricing for
  ~770 xDAI of cumulative buying — about five depth-26 year drives — and the
  direct pool for ~230, which `verify:chain` spends 0.5 at a time, so ~460
  runs. Quote it in xDAI, not purchases: the count scales with the swap size.

  The remedy is a **volume reset**, not a re-bake: `bee-compose stop --rm`,
  `scripts/fresh.sh`, or any `down -v` re-seeds `/data` from the baked
  snapshot and hands every range back, offline and in seconds. Re-bake only
  to move the fork forward. (The direct ladder stopping at ~9 xDAI, and the
  revert a 49-xDAI ladder hit at some fork blocks, are bake-time stories, not
  runtime bounds — see `warm-dex.ts`.)
- **Prices are frozen** at the fork block, and **the block height is mainnet's**
  (~47.7M) — a dump cannot be rewound, since anvil refuses to load a hand-edited
  one. Nothing depends on the height now that the contracts are fresh, but it
  does move `BEE_POSTAGE_STAMP_START_BLOCK` on every bake.
- **Bee's synthetic outpayment baseline is gone**, and worth knowing as a
  mechanism. On the old mainnet dump a node with no chain history synthesised a
  total-outpayment near `price × block height` (~1.14e12 per chunk) and wrote
  off anything funded below it as a `low balance batch`. Here it learns the
  price from the `PriceUpdate` the bake emits, so its chain state starts at
  `totalAmount: 0` and batches funded at the contract's own floor are accepted.
  Check `GET /chainstate` before blaming a funding amount.

## Re-baking

Needs internet — it forks mainnet and downloads solc. Replaying the result does
not. From the repo root:

```bash
pnpm install --ignore-workspace   # once; a plain install picks up a parent workspace
pnpm bake                         # rewrites state.gnosis.json and compose.yml
docker compose build blockchain   # bake the new state into the image
```

`BEE_POSTAGE_STAMP_START_BLOCK` is **written, not printed**: PostageStamp lands
in a new block every bake, and a stale value hides the initial `PriceUpdate` and
every `BatchCreated` from the nodes — batches on chain that no node has heard
of, with no error anywhere. Commit the snapshot and that edit together, and
don't hand-edit it back.

Contract addresses do not move, and `GNOSIS_FORK_BLOCK` pins the fork height so
two bakes differ only where you changed something. `FOUNDRY_IMAGE` and
`GNOSIS_RPC_URL` override the toolchain and upstream.

To bump the contract submodule:

```bash
git -C blockchain/deploy/lib/storage-incentives fetch --tags
git -C blockchain/deploy/lib/storage-incentives checkout v0.9.5   # for example
git add blockchain/deploy/lib/storage-incentives                  # record the new SHA
pnpm bake && docker compose build blockchain
```

Addresses come from the deployer/nonce pair, not the bytecode, so they survive a
bump — but check the constructor signatures still match `bake/deploy-swarm.ts`
before trusting one.
