// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";
import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice One-transaction switch of an unlocked Surface collection to an
///         already-deployed AntonRenderer. Leaves the minter and mints intact.
///
///         ANTON_COLLECTION  existing Surface collection to repoint
///         ANTON_RENDERER    new renderer, checked before the broadcast
///         ANTON_STORE       store holding the reviewed gzip bytes
///         RENDER_ASSETS     new editable-text registry
contract SwapAntonRenderer is AntonDeploy {
    function run() external {
        address collection = vm.envAddress("ANTON_COLLECTION");
        address renderer = vm.envAddress("ANTON_RENDERER");
        assertAntonRenderer(renderer, vm.envAddress("ANTON_STORE"), vm.envAddress("RENDER_ASSETS"));

        vm.startBroadcast();
        ISurfaceCore(collection).setRenderer(renderer);
        vm.stopBroadcast();

        console2.log("new AntonRenderer:   ", renderer);
        console2.log("collection:          ", collection);
    }
}
