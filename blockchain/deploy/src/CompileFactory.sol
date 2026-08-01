// SPDX-License-Identifier: BSD-3-Clause
// Stub that imports SimpleSwapFactory so Foundry compiles it. The Deploy
// script can't import it directly (cross-solc-version imports are forbidden)
// and uses vm.getCode to load the artifact at runtime instead. This file
// exists solely to drag the contract into the build graph.
pragma solidity =0.7.6;
pragma abicoder v2;

import "../lib/swap-swear-and-swindle/contracts/SimpleSwapFactory.sol";
