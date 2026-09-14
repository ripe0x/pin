// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice Deploys the anton work's stateless art contracts: AntonScriptStore
///         and AntonRenderer, bound to an existing RenderAssets singleton. This
///         is the mainnet deploy step; the artist then creates the collection
///         from their own wallet in the studio UI, pasting the renderer address.
///
///         PRIVATE_KEY    deployer/signer
///         RENDER_ASSETS  deployed RenderAssets singleton (see
///                        DeployRenderModules.s.sol); required, non-zero
contract DeployAntonRenderer is AntonDeploy {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address renderAssets = vm.envAddress("RENDER_ASSETS");

        vm.startBroadcast(pk);
        (address store, address renderer) = deployAntonRenderer(renderAssets);
        vm.stopBroadcast();

        console2.log("AntonScriptStore:", store);
        console2.log("AntonRenderer:   ", renderer);
        console2.log("renderAssets:    ", renderAssets);
    }
}
