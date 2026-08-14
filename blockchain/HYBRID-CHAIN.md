# Hybrid chain: mainnet DEX, freshly deployed Swarm contracts

The chain this cluster runs on, and why it is put together the way it is.
Built by `blockchain/bake/bake.sh`; the result is `blockchain/state.gnosis.json`.

## Why

Two approaches were tried and each fails on its own:

- **Deploy everything from source** (what this repo did originally). The Swarm
  contracts are deterministic and the batch tree starts empty, but there is no
  DEX and no BZZ market, so postage cannot be bought the way a product buys it
  (swap xDAI for BZZ, then `createBatch`).
- **Snapshot Gnosis mainnet.** The DEX, BZZ and the pools are all real, but
  `PostageStamp.createBatch` walks a tree of every batch on the chain, and a
  state dump only keeps storage something touched — so the traversal eventually
  reaches a node that is not there and reverts `BatchDoesNotExist()`
  (`0x4ee9bc0f`). Purchases work for a while after a reset and then stop, for
  good, regardless of the amount.

The hybrid takes from mainnet only what is hard to deploy, and deploys the rest
fresh:

| From the mainnet snapshot | Deployed from source |
| --- | --- |
| BZZ token, SushiSwap router / quoter / pool, WXDAI | PostageStamp, PriceOracle, StakeRegistry, Redistribution |

The Swarm contracts start with an **empty batch tree** — no traversal hazard,
fully deterministic — while swaps still price against real liquidity.

## Landing them on their mainnet addresses

Worth doing: an app resolves contract addresses from the chain id, so a chain
answering as Gnosis (100) is expected to carry the Gnosis deployments.

A CREATE address is `keccak(rlp([deployer, nonce]))` and anvil can impersonate
any account and set its nonce, so deploying as a contract's *original* deployer
at its *original* nonce reproduces the address exactly:

```
anvil_setBalance          <deployer> <gas>
anvil_setNonce            <deployer> <original nonce>
anvil_impersonateAccount  <deployer>
eth_sendTransaction { from: <deployer>, data: <initCode ++ constructorArgs> }
```

All four Swarm contracts on Gnosis came from the same EOA
`0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA`, so they are deployed in nonce
order. Deployer and nonce are recoverable from the creation transaction:
`https://gnosis.blockscout.com/api/v2/addresses/<addr>` gives
`creator_address_hash` and `creation_transaction_hash`, then
`eth_getTransactionByHash` gives the nonce.

| Contract | Address | Nonce | Constructor args used here |
| --- | --- | --- | --- |
| PostageStamp | `0x45a1502382541Cd610CC9068e88727426b696293` | 6891 | `_bzzToken=0xdBF3…F68da`, `_minimumBucketDepth=16` |
| PriceOracle | `0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b` | 7039 | `_postageStamp=0x45a1…6293` |
| StakeRegistry | `0xda2a16EE889E7F04980A8d597b48c8D51B9518F4` | 7059 | `_bzzToken=0xdBF3…F68da`, `_NetworkId=4020`, `_oracleContract=0x47Ee…0a8b` |
| Redistribution | `0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d` | 7070 | `staking=0xda2a…18F4`, `postageContract=0x45a1…6293`, `oracleContract=0x47Ee…0a8b` |

The address depends only on deployer and nonce, **not** on the constructor
arguments — which is why StakeRegistry can take this cluster's network id
(4020) rather than mainnet's 1 and still land on the mainnet address.

Sources are `ethersphere/storage-incentives` at the pinned submodule tag,
compiled with the settings mainnet's own deployments were verified with
(solc 0.8.19, optimizer on, 1000 runs, EVM paris).

## How the bake is staged

`blockchain/bake/bake.sh`, three stages, and the split is the design:

1. **`warm-dex.ts`, against a fork of mainnet.** Trades through the real
   BZZ/WXDAI pool across an ascending ladder of sizes — a swap only warms the
   ticks it crosses, so a later trade of a different size would reach for slots
   that were never fetched — then sells the whole position back, which leaves
   the same ticks warm in both directions and hands the pool over near the
   price it started at. Keeps 250 BZZ back for the dev faucet instead of
   selling it, and funds the nine Bee node EOAs. It also **pins the storage
   behind every read-only call** the offline chain must answer — see below. It
   touches **nothing else**: untouched, the Swarm contracts stay out of the
   dump and their addresses reload empty.
2. **`deploy-swarm.ts`, against a plain anvil loaded with that dump.** Not a
   fork — that matters. On a fork those addresses still hold mainnet's code and
   CREATE would refuse to overwrite them, and clearing the code with
   `anvil_setCode` would leave mainnet's storage readable underneath, which is
   exactly how the batch-tree hazard would sneak back in. On the loaded dump
   they are genuinely empty. Deploys, asserts each address, wires the roles and
   sets the initial price.
3. **`finalise.ts`.** Splices back the contracts a dump drops (anything the
   flows only *call* — the SushiSwap quoter), asserts the result is whole —
   code at every borrowed and deployed address, gas on every node EOA — and
   writes `BEE_POSTAGE_STAMP_START_BLOCK` into `compose.yml`, since PostageStamp
   lands in a new block every bake and a stale value hides every batch.

A `forge script` broadcast cannot do step 2 — it deploys from one sender at its
natural nonce — which is why `blockchain/deploy/` only compiles the contracts
and the deploy transactions are sent from TypeScript.

## What a dump drops, and the two ways to get it back

A fork fetches state lazily, and the dump keeps only what something **wrote**
to. So anything the chain has to *answer* rather than *execute* goes missing,
in two different shapes:

- **A whole contract**, when nothing ever sent it a transaction. The SushiSwap
  quoter is only ever `eth_call`ed, so it reloads with no code and every quote
  returns empty. `finalise.ts` fetches its code from upstream and splices it in
  (`READ_ONLY_CONTRACTS`).
- **Individual slots** of a contract that *is* present. `BZZ.decimals()`,
  `symbol()`, `name()` and `totalSupply()` read slots the trading never wrote,
  so they reloaded as `0` and `""` — and a missing slot reads as zero rather
  than reverting, so nothing anywhere reports a fault while every consumer
  formats its amounts 1e16 out. `warmReads()` traces each call with
  `prestateTracer`, which reports every slot it touches (through the proxy's
  delegatecall included), and writes each one back at the value it already
  holds: a no-op on chain, but it marks the slot dirty, so it is dumped.

Both are asserted after the reload — the splice in `finalise.ts`, the metadata
in `deploy-swarm.ts`, which is the first stage to run against the reloaded
dump. Anything new the chain must answer without executing needs one of these
two treatments, and the assertion matters more than the mechanism: this class
of failure is silent by construction.

## What this fixed, and what it did not

`pnpm verify:chain` buys postage the product's way (swap, approve,
`createBatch`) repeatedly against a running cluster. The old chain managed a
handful of purchases and then reverted `BatchDoesNotExist()` forever; this one
does not.

Two consequences of the fresh contracts are worth knowing:

- **Bee's outpayment baseline is gone.** On the mainnet snapshot a node with no
  chain history synthesised a total-outpayment near `price × block height`
  (~1.14e12 per chunk), and wrote off anything funded below it as a
  `low balance batch`. Here the node learns the price from the `PriceUpdate`
  event the bake emits, so its chain state starts at `amount=0` and batches
  funded at the contract's own floor are accepted.
- **The block height is still mainnet's** (~47.7M), because a state dump cannot
  be rewound — anvil refuses to load a hand-edited one. Nothing depends on it
  now that the contracts are fresh, but it does mean
  `BEE_POSTAGE_STAMP_START_BLOCK` in `compose.yml` moves with every re-bake.
  `finalise.ts` writes it, so the only thing left to get wrong is committing
  the snapshot without it.
- **The pool is small.** ~180 WXDAI against 19 300 BZZ, roughly $1.2k, so the
  ~49 xDAI ladder is about a quarter of the quote side and ~0.5 xDAI of buying
  moves the price ~0.6%. Good for a few hundred purchases, not for an
  arbitrarily long-lived chain.
