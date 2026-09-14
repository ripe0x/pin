// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";
import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice Deploys a fresh AntonScriptStore + AntonRenderer from the current
///         script/anton.js.gz and points an existing Surface collection at the
///         new renderer via setRenderer. Leaves the collection, minter and any
///         mints untouched. Requires the collection's renderer to be unlocked
///         and the signer to be its owner or an admin.
///
///         PRIVATE_KEY   deployer/signer (owner or admin of the collection)
///         ANTON_COLLECTION  existing Surface collection to repoint
///         RENDER_ASSETS     deployed RenderAssets singleton (see
///                           DeployRenderModules.s.sol); required, non-zero
contract SwapAntonRenderer is AntonDeploy {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address collection = vm.envAddress("ANTON_COLLECTION");
        address renderAssets = vm.envAddress("RENDER_ASSETS");

        vm.startBroadcast(pk);

        (address store, address renderer) = deployAntonRenderer(renderAssets);
        ISurfaceCore(collection).setRenderer(renderer);

        vm.stopBroadcast();

        console2.log("new AntonScriptStore:", store);
        console2.log("new AntonRenderer:   ", renderer);
        console2.log("renderAssets:        ", renderAssets);
        console2.log("collection:          ", collection);
    }
}
