// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";

/// @notice One-transaction switch of an unlocked Surface collection to an
///         already-deployed AntonRenderer. Leaves the minter and mints intact.
///
///         ANTON_COLLECTION  existing Surface collection to repoint
///         ANTON_RENDERER    new renderer, checked before the broadcast
contract SwapAntonRenderer is Script {
    function run() external {
        address collection = vm.envAddress("ANTON_COLLECTION");
        address renderer = vm.envAddress("ANTON_RENDERER");
        require(renderer.code.length > 0, "ANTON_RENDERER has no code");

        vm.startBroadcast();
        ISurfaceCore(collection).setRenderer(renderer);
        vm.stopBroadcast();

        console2.log("new AntonRenderer:   ", renderer);
        console2.log("collection:          ", collection);
    }
}
