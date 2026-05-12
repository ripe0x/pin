// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArtistRecordRegistry} from "../src/ArtistRecordRegistry.sol";

/// @notice Mainnet deploy script for ArtistRecordRegistry.
/// @dev    The registry is fully immutable. No constructor arguments,
///         no admin, no upgrade path. One deploy, forever.
///
///         Run with:
///           forge script script/DeployArtistRecordRegistry.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         Deterministic-address note: if you want the registry to land
///         on the same address across chains in the future, deploy via
///         a CREATE2 factory (e.g. ImmutableCreate2Factory). The plain
///         deploy below uses CREATE, so the address depends on the
///         deployer's nonce. Mainnet-only is the current plan, so CREATE
///         is fine.
contract DeployArtistRecordRegistryScript is Script {
    function run() external {
        vm.startBroadcast();
        ArtistRecordRegistry registry = new ArtistRecordRegistry();
        vm.stopBroadcast();

        console2.log("ArtistRecordRegistry deployed at:", address(registry));
    }
}
