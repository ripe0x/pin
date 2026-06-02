// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PNDEditions} from "../src/editions/PNDEditions.sol";
import {PNDEditionsFactory} from "../src/editions/PNDEditionsFactory.sol";
import {PNDDefaultRenderer} from "../src/editions/PNDDefaultRenderer.sol";

/// @notice Deploy script for the PND Editions system: the built-in default
///         renderer, the shared PNDEditions implementation, and the factory.
///         No constructor parameters and no admin — there is no protocol fee,
///         so there is nothing to misconfigure.
///
///         Run with:
///           forge script script/DeployEditions.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
///
///         After deploy:
///           node scripts/emit-editions-abi.mjs   # refresh frontend ABIs
///           # then paste the factory address into packages/addresses/src/index.ts
contract DeployEditions is Script {
    function run() external {
        vm.startBroadcast();
        PNDDefaultRenderer renderer = new PNDDefaultRenderer();
        PNDEditions impl = new PNDEditions();
        PNDEditionsFactory factory = new PNDEditionsFactory(address(impl), address(renderer));
        vm.stopBroadcast();

        require(factory.implementation() == address(impl), "impl mismatch");
        require(factory.defaultRenderer() == address(renderer), "renderer mismatch");
        require(address(impl).code.length > 0, "impl has no code");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("PNDDefaultRenderer:   ", address(renderer));
        console2.log("PNDEditions impl:     ", address(impl));
        console2.log("PNDEditionsFactory:   ", address(factory));
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  PND_EDITIONS_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
    }
}
