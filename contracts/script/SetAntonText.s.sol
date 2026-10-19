// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";

/// @notice One-transaction owner/admin update of Anton's metadata copy.
///         Edit script/anton-metadata.json, then provide ANTON_COLLECTION and
///         RENDER_ASSETS with forge --account/--sender. Blank values fall back
///         to the renderer's constructor text.
contract SetAntonText is Script {
    function run() external {
        address collection = vm.envAddress("ANTON_COLLECTION");
        address assets = vm.envAddress("RENDER_ASSETS");
        require(assets.code.length > 0, "RENDER_ASSETS has no code");
        string memory json = vm.readFile("script/anton-metadata.json");
        string memory tokenDescription = vm.parseJsonString(json, ".tokenDescription");
        string memory collectionDescription = vm.parseJsonString(json, ".collectionDescription");
        string memory externalUrl = vm.parseJsonString(json, ".externalUrl");

        vm.startBroadcast();
        RenderAssets(assets).setText(collection, tokenDescription, collectionDescription, externalUrl);
        vm.stopBroadcast();
        console2.log("RenderAssets text updated for:", collection);
    }
}
