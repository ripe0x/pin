// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";

/// @notice Grants a capturer on RenderAssets for an anton collection and,
///         optionally, sets its cover. Requires the signer to be the
///         collection's owner or an admin (RenderAssets borrows the
///         collection's own authority).
///
///         PRIVATE_KEY       deployer/signer (owner or admin of the collection)
///         RENDER_ASSETS     deployed RenderAssets singleton
///         ANTON_COLLECTION  Surface collection to configure
///         ANTON_CAPTURER    account granted the capturer role
///         ANTON_COVER       cover image URI; omit or leave empty to skip
contract ConfigureAntonAssets is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address renderAssetsAddr = vm.envAddress("RENDER_ASSETS");
        require(renderAssetsAddr != address(0), "RENDER_ASSETS not set");
        address collection = vm.envAddress("ANTON_COLLECTION");
        address capturer = vm.envAddress("ANTON_CAPTURER");
        string memory cover = vm.envOr("ANTON_COVER", string(""));

        RenderAssets renderAssets = RenderAssets(renderAssetsAddr);

        vm.startBroadcast(pk);

        renderAssets.setCapturer(collection, capturer, true);
        if (bytes(cover).length > 0) {
            renderAssets.setCover(collection, cover);
        }

        vm.stopBroadcast();

        console2.log("capturer granted:", capturer);
        console2.log("isCapturer:      ", renderAssets.isCapturer(collection, capturer));
        console2.log("coverOf:         ", renderAssets.coverOf(collection));
    }
}
