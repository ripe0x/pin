// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";
import {DefaultRenderer} from "../src/surface/renderers/DefaultRenderer.sol";

/// @notice Deploy script for the two renderer-land singletons: RenderAssets
///         (cover + capture storage) and DefaultRenderer (data-URI tokenURI
///         reading RenderAssets). Both are ownerless and immutable; neither
///         is referenced by the factory (collections opt in per cfg.renderer),
///         so this script is independent of DeploySurfaceSystem and can run
///         before or after it.
///
/// @dev    DefaultRenderer takes the RenderAssets address in its constructor.
///         Set RENDER_ASSETS to reuse an already-deployed RenderAssets;
///         unset, the script deploys a fresh one first.
///
///         The signer comes from the CLI, not from the script: vm.startBroadcast()
///         takes no key, so forge uses whatever --account / --ledger / --private-key
///         you pass. Prefer an encrypted keystore account (no raw key on disk).
///
///         Run with (mainnet, keystore account):
///           forge script script/DeployRenderModules.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --account <name> --sender <deployer address> \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         To preview without broadcasting (dry run; pass --sender so the
///         simulation has an origin, but no tx is sent without --broadcast):
///           forge script script/DeployRenderModules.s.sol \
///             --rpc-url $MAINNET_RPC_URL --sender <deployer address>
///
///         No private key is read, printed, logged, or echoed anywhere in this
///         script; signing and the password prompt are handled by forge.
contract DeployRenderModulesScript is Script {
    function run() external {
        // ── 1. RenderAssets. Reuse an existing deployment when RENDER_ASSETS
        //      is set; deploy fresh otherwise.
        address renderAssets = vm.envOr("RENDER_ASSETS", address(0));
        if (renderAssets == address(0)) {
            vm.startBroadcast();
            renderAssets = address(new RenderAssets());
            vm.stopBroadcast();
            console2.log("RenderAssets deployed at:", renderAssets);
        } else {
            require(renderAssets.code.length > 0, "RENDER_ASSETS has no code");
            console2.log("Using existing RenderAssets at:", renderAssets);
        }

        // ── 2. DefaultRenderer, bound to RenderAssets in its constructor.
        vm.startBroadcast();
        DefaultRenderer renderer = new DefaultRenderer(renderAssets);
        vm.stopBroadcast();

        require(address(renderer.renderAssets()) == renderAssets, "renderAssets binding mismatch");
        require(address(renderer).code.length > 0, "renderer has no code");
        console2.log("DefaultRenderer deployed at:", address(renderer));

        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary:");
        console2.log("  RenderAssets:    ", renderAssets);
        console2.log("  DefaultRenderer: ", address(renderer));
    }
}
