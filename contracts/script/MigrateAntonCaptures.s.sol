// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";
import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";

/// @notice Copy the current Sepolia capture template to the new registry.
///         Simulation checks image parity for every minted token before any
///         broadcast. Requires the collection owner/admin as signer.
contract MigrateAntonCaptures is Script {
    function run() external {
        address collection = vm.envAddress("ANTON_COLLECTION");
        address oldAddress = vm.envAddress("ANTON_OLD_RENDER_ASSETS");
        address newAddress = vm.envAddress("RENDER_ASSETS");
        require(oldAddress.code.length > 0 && newAddress.code.length > 0, "registry missing code");
        RenderAssets oldAssets = RenderAssets(oldAddress);
        RenderAssets newAssets = RenderAssets(newAddress);
        string memory template = oldAssets.templateOf(collection);
        uint256 bound = oldAssets.templateMaxTokenIdOf(collection);
        require(bytes(template).length > 0 && bound > 0, "no capture template");

        vm.startBroadcast();
        newAssets.setCaptureTemplate(collection, template, bound);
        vm.stopBroadcast();

        (, uint256 minted) = ISurfaceCore(collection).config();
        for (uint256 id = 1; id <= minted; id++) {
            require(
                keccak256(bytes(newAssets.imageFor(collection, id)))
                    == keccak256(bytes(oldAssets.imageFor(collection, id))),
                "capture image mismatch"
            );
        }
        console2.log("capture template migrated for:", collection);
        console2.log("template bound:", bound);
        console2.log("token images checked:", minted);
    }
}
