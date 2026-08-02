// SPDX-License-Identifier: BSD-3-Clause
// Drags the four Swarm contracts into the build graph so `forge build` emits
// their artifacts. There is no deploy script here on purpose: the contracts
// have to land on their Gnosis mainnet addresses, which means impersonating
// each one's original deployer at its original nonce — something a `forge
// script` broadcast cannot do, since it deploys from one sender at its natural
// nonce. blockchain/bake/deploy-swarm.ts reads these artifacts and sends the
// transactions itself.
//
// Named imports, not global ones: Staking.sol and Redistribution.sol both
// declare an IPriceOracle interface, which collides at file scope.
pragma solidity ^0.8.19;

import {PostageStamp} from "../lib/storage-incentives/src/PostageStamp.sol";
import {PriceOracle} from "../lib/storage-incentives/src/PriceOracle.sol";
import {StakeRegistry} from "../lib/storage-incentives/src/Staking.sol";
import {Redistribution} from "../lib/storage-incentives/src/Redistribution.sol";
