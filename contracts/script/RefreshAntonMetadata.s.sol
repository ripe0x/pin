// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";

/// @notice Ask metadata consumers to re-fetch after a RenderAssets text edit.
///         While unlocked, re-setting the same renderer emits both the token
///         and collection metadata update events. After lock, only the token
///         event is available from this deployed Surface core.
contract RefreshAntonMetadata is Script {
    function run() external {
        ISurfaceCore collection = ISurfaceCore(vm.envAddress("ANTON_COLLECTION"));
        (SurfaceConfig memory cfg,) = collection.config();

        vm.startBroadcast();
        if (cfg.rendererLocked) {
            collection.notifyMetadataUpdate(0, type(uint256).max);
        } else {
            collection.setRenderer(cfg.renderer);
        }
        vm.stopBroadcast();

        console2.log("token metadata refresh requested through:", address(collection));
        if (cfg.rendererLocked) console2.log("collection copy may need a manual marketplace refresh");
    }
}
