// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console2} from "forge-std/Script.sol";

import {TestToken} from "../lib/storage-incentives/src/TestToken.sol";
import {PostageStamp} from "../lib/storage-incentives/src/PostageStamp.sol";
import {PriceOracle} from "../lib/storage-incentives/src/PriceOracle.sol";
import {StakeRegistry} from "../lib/storage-incentives/src/Staking.sol";
import {Redistribution} from "../lib/storage-incentives/src/Redistribution.sol";

/// @notice Deploys the full Swarm contract suite onto a fresh Anvil instance.
///
/// Determinism strategy: standard CREATE from a fixed deployer EOA (Anvil's
/// well-known account[0]) at predictable nonces. Every redeploy starts from
/// an empty chain, so nonce 0..N produces the same six addresses as long as
/// neither the bytecode nor the deploy order changes. Reorder a step here and
/// every address downstream shifts — keep the order stable, or update
/// compose.yml's x-bee-env block when it has to change.
///
/// Why not CREATE2? `new Contract{salt: ...}(args)` in Foundry routes through
/// the deterministic deployer proxy at 0x4e59…b44, so `msg.sender` inside the
/// constructor is the proxy — not our EOA. AccessControl-derived contracts
/// like PostageStamp grant DEFAULT_ADMIN_ROLE to msg.sender in the
/// constructor, which means CREATE2-deployed contracts hand admin to the
/// proxy and our EOA can never wire up roles. CREATE keeps msg.sender == EOA.
///
/// SimpleSwapFactory lives at solc 0.7.6 and can't be imported from this
/// 0.8.19 script. We instantiate it via raw bytecode + assembly create.
contract Deploy is Script {
    uint64  constant NETWORK_ID       = 4020;
    uint8   constant MIN_BUCKET_DEPTH = 16;
    uint32  constant INITIAL_PRICE    = 16384;

    // BZZ uses 16 decimals (see TestToken.decimals()).
    uint256 constant BZZ_DECIMALS_FACTOR = 1e16;
    uint256 constant INITIAL_SUPPLY      = 1_000_000_000 * BZZ_DECIMALS_FACTOR; // 1B BZZ
    uint256 constant BZZ_PER_NODE        = 100_000      * BZZ_DECIMALS_FACTOR; // 100k BZZ

    uint256 constant ETH_PER_NODE = 100 ether;

    // Bee node addresses derived from baked swarm.key files in bee/data/.
    // Update this list if you regenerate keys.
    function _beeNodes() internal pure returns (address[5] memory nodes) {
        nodes[0] = 0x26234a2ad3bA8B398A762f279B792cfAcd536a3f; // queen
        nodes[1] = 0x8E3cB0148c5F39577fb815Dc8c37795E30f5dcfA; // worker-1
        nodes[2] = 0xeD52B8Ac9B1BC1e7F3fe46ea3a094FBaa8F6ccB4; // worker-2
        nodes[3] = 0x119331B8074bD779fc5B96Fe4d50947d31aDdfe4; // worker-3
        nodes[4] = 0x102aAA556337d86e270010588D9fBD5EcaeeBFF8; // worker-4
    }

    function run() public {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        TestToken bzz = new TestToken("BZZ", "BZZ", INITIAL_SUPPLY);

        PostageStamp  postage  = new PostageStamp(address(bzz), MIN_BUCKET_DEPTH);
        PriceOracle   oracle   = new PriceOracle(address(postage));
        StakeRegistry staking  = new StakeRegistry(address(bzz), NETWORK_ID, address(oracle));
        Redistribution redist  = new Redistribution(address(staking), address(postage), address(oracle));

        address factory = _deployFactory(address(bzz));

        // Role wiring — once the oracle holds PRICE_ORACLE_ROLE on postage
        // it can drive setPrice; redistribution drives the other two.
        postage.grantRole(postage.PRICE_ORACLE_ROLE(),  address(oracle));
        postage.grantRole(postage.REDISTRIBUTOR_ROLE(), address(redist));
        oracle .grantRole(oracle .PRICE_UPDATER_ROLE(), address(redist));
        staking.grantRole(staking.REDISTRIBUTOR_ROLE(), address(redist));

        // Seed an initial price so the postage stamp's "is this batch usable"
        // check has a real number to compare against.
        oracle.setPrice(INITIAL_PRICE);

        // Fund bee nodes with gas ETH + BZZ for chequebook + stamps.
        address[5] memory nodes = _beeNodes();
        for (uint256 i = 0; i < nodes.length; i++) {
            payable(nodes[i]).transfer(ETH_PER_NODE);
            bzz.transfer(nodes[i], BZZ_PER_NODE);
        }

        vm.stopBroadcast();

        console2.log("=== contract addresses ===");
        console2.log("BZZ token         :", address(bzz));
        console2.log("PostageStamp      :", address(postage));
        console2.log("PriceOracle       :", address(oracle));
        console2.log("StakeRegistry     :", address(staking));
        console2.log("Redistribution    :", address(redist));
        console2.log("SimpleSwapFactory :", factory);
    }

    function _deployFactory(address bzz) internal returns (address factory) {
        bytes memory creationCode = vm.getCode("SimpleSwapFactory.sol:SimpleSwapFactory");
        bytes memory initCode = abi.encodePacked(creationCode, abi.encode(bzz));
        assembly {
            factory := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(factory != address(0), "factory: create failed");
    }
}
