// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ReleaseFactory} from "../src/releases/ReleaseFactory.sol";

/// @notice Deploy script for the Releases protocol: one contract, the
///         factory. Releases themselves are deployed by artists through it.
///
///         Constants (overridable via env):
///           SURFACE_FEE_WEI         initial per-token surface fee
///                                   (default 0.0005 ether)
///           MAX_SURFACE_FEE_WEI     the forever cap, baked into bytecode
///                                   (default 0.002 ether)
///           RELEASES_FACTORY_OWNER  controls setSurfaceFee and nothing
///                                   else (default: the broadcaster)
///
///         Run with:
///           forge script script/DeployReleases.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
///
///         After deploy:
///           # paste the factory address into packages/addresses/src/index.ts
///           # wire the indexer (address + deploy block) per the runbook
///
///         Releases created by the factory share identical creation code,
///         so after the first one is verified on Etherscan every later one
///         auto-matches.
contract DeployReleases is Script {
    uint256 internal constant DEFAULT_SURFACE_FEE = 0.0005 ether;
    uint256 internal constant DEFAULT_MAX_SURFACE_FEE = 0.002 ether;

    function run() external returns (ReleaseFactory factory) {
        uint256 surfaceFee =
            vm.envOr("SURFACE_FEE_WEI", DEFAULT_SURFACE_FEE);
        uint256 maxSurfaceFee =
            vm.envOr("MAX_SURFACE_FEE_WEI", DEFAULT_MAX_SURFACE_FEE);

        vm.startBroadcast();
        address owner = vm.envOr("RELEASES_FACTORY_OWNER", msg.sender);
        factory = new ReleaseFactory(owner, maxSurfaceFee, surfaceFee);
        vm.stopBroadcast();

        require(factory.owner() == owner, "owner mismatch");
        require(factory.surfaceFee() == surfaceFee, "fee mismatch");
        require(factory.maxSurfaceFee() == maxSurfaceFee, "cap mismatch");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("ReleaseFactory:    ", address(factory));
        console2.log("  owner:           ", owner);
        console2.log("  surfaceFee (wei):", surfaceFee);
        console2.log("  max fee (wei):   ", maxSurfaceFee);
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  RELEASE_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
    }
}
