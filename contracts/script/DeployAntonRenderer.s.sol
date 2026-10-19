// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice One-transaction renderer deployment, bound to an existing Anton
///         store and an editable-text RenderAssets. Deploy the store first.
///
///         ANTON_STORE    AntonScriptStore deployed from the current artwork
///         RENDER_ASSETS  deployed RenderAssets singleton (see
///                        DeployRenderModules.s.sol); must have setText getters
contract DeployAntonRenderer is AntonDeploy {
    function run() external {
        address store = vm.envAddress("ANTON_STORE");
        address renderAssets = vm.envAddress("RENDER_ASSETS");

        vm.startBroadcast();
        address renderer = deployAntonRendererFromStore(store, renderAssets);
        vm.stopBroadcast();

        console2.log("AntonScriptStore:", store);
        console2.log("AntonRenderer:   ", renderer);
        console2.log("renderAssets:    ", renderAssets);
    }
}
