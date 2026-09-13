// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";

import {AntonScriptStore} from "../src/surface/works/anton/AntonScriptStore.sol";
import {AntonRenderer} from "../src/surface/works/anton/AntonRenderer.sol";
import {CodeKind, CodeRef} from "../src/surface/templates/CodeTypes.sol";

/// @notice Shared deploy step for the anton work's stateless art contracts.
///         Used by every anton script (DeployAntonRenderer, DeployAntonWork,
///         SwapAntonRenderer) so the store + renderer deploy exists once.
abstract contract AntonDeploy is Script {
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";

    /// @dev Reads script/anton.js.gz, deploys AntonScriptStore, then
    ///      AntonRenderer wired to scripty + EthFS gunzip and the given
    ///      RenderAssets singleton. Caller must wrap this in its own
    ///      vm.startBroadcast/stopBroadcast.
    function deployAntonRenderer(address renderAssets) internal returns (address store, address renderer) {
        require(renderAssets != address(0), "RENDER_ASSETS not set");

        // Scripty stores serve base64 TEXT (the EthFS convention).
        bytes memory scriptB64 = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));
        store = address(new AntonScriptStore(scriptB64));

        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        renderer = address(
            new AntonRenderer(
                SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE, code, new CodeRef[](0), 1, renderAssets
            )
        );
    }
}
