# Hybrid chain: mainnet DEX, freshly deployed Swarm contracts

The plan for the chain this cluster should run on, and why. Not implemented yet
— the two mechanisms it depends on are proven (below), the wiring is not.

## Why

Two approaches were tried and each fails on its own:

- **Deploy everything from source** (what this repo did originally). The Swarm
  contracts are deterministic and the batch tree starts empty, but there is no
  DEX and no BZZ market, so postage cannot be bought the way a product buys it
  (swap xDAI for BZZ, then `createBatch`).
- **Snapshot Gnosis mainnet.** The DEX, BZZ and the pools are all real, but
  `PostageStamp.createBatch` walks a tree of every batch on the chain, and a
  state dump only keeps storage something touched — so the traversal eventually
  reaches a node that is not there and reverts `BatchDoesNotExist()`. Purchases
  work for a while after a reset and then stop.

The hybrid takes from mainnet only what is hard to deploy, and deploys the rest
fresh:

| From the mainnet snapshot | Deployed from source |
| --- | --- |
| BZZ token, SushiSwap router / quoter / pools, WXDAI | PostageStamp, PriceOracle, StakeRegistry, Redistribution |

The Swarm contracts then start with an **empty batch tree** — no traversal
hazard, fully deterministic — while swaps still price against real liquidity.

## Landing them on their mainnet addresses

Worth doing: the app resolves contract addresses from the chain id, so a chain
answering as Gnosis (100) is expected to carry the Gnosis deployments. Fresh
deploys can be placed at those exact addresses.

**Mechanism (verified):** a CREATE address is `keccak(rlp([deployer, nonce]))`,
and anvil can impersonate any account and set its nonce. So deploying as the
contract's *original* deployer, with the *original* nonce, reproduces the
address exactly:

```
anvil_setBalance   <original deployer>  <gas>
anvil_setNonce     <original deployer>  <original nonce>
anvil_impersonateAccount <original deployer>
eth_sendTransaction { from: <deployer>, data: <initCode ++ constructorArgs> }
```

A throwaway proof of this returned the address `getContractAddress` predicts.

**The addresses are only free of collisions if the snapshot does not already
contain them** — so the bake must *delete* the four Swarm contract accounts
from the dumped JSON. Clearing code via `anvil_setCode` is not enough: the old
storage would remain and the new contract would read another contract's slots,
which is how the batch-tree hazard would sneak back in.

**Original deployer and nonce**, recovered from the creation transaction
(`/api/v2/addresses/<addr>` on gnosis.blockscout.com gives the creator and the
creation tx; `eth_getTransactionByHash` gives the nonce):

| Contract | Address | Deployer | Nonce |
| --- | --- | --- | --- |
| PostageStamp | `0x45a1502382541Cd610CC9068e88727426b696293` | `0x647942035bb69c8e4d7eb17c8313ebc50b0babfa` | 6891 |
| PriceOracle | `0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b` | _look up_ | _look up_ |
| StakeRegistry | `0xda2a16EE889E7F04980A8d597b48c8D51B9518F4` | _look up_ | _look up_ |
| Redistribution | `0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d` | _look up_ | _look up_ |

Constructor arguments must match mainnet's — for PostageStamp,
`_bzzToken = 0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da` and
`_minimumBucketDepth = 16` (from its verified source).

If forcing an address proves troublesome for one of them, the fallback is to
accept whatever address it lands on and pass it through as a parameter: the
`${VAR:-default}` indirection for every `BEE_*` contract address was in place
at commit `cab6858` and can be restored.

## Steps

1. **Bake**: fork mainnet, warm the DEX paths (swaps across a range of sizes —
   a swap only warms the ticks it crosses), then *delete* the four Swarm
   contract accounts from the dump, and splice in the read-only contracts a
   dump drops (the SushiSwap quoter). Fund the nine Bee node EOAs with xDAI.
2. **Deploy on boot**: an init step that impersonates each original deployer,
   sets the nonce, deploys the compiled contract, asserts the resulting address
   matches, then wires the roles and the initial price exactly as
   `deploy/script/Deploy.s.sol` does today.
3. **Verify**: `createBatch` repeatedly on a long-lived chain (the failure mode
   this design exists to remove only appeared after several purchases), then
   buy → extend → resize → upload through a node.

Step 2 cannot be a plain `forge script` broadcast: that deploys from one
sender at its natural nonce. It needs to send the deploy transactions itself
(compiled artifacts from `forge build`, addresses forced as above), which is
why it belongs in the TS tooling rather than in Solidity.
