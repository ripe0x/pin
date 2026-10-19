// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";

import {AntonScriptStore} from "../src/surface/works/anton/AntonScriptStore.sol";
import {AntonRenderer} from "../src/surface/works/anton/AntonRenderer.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";
import {CodeKind, CodeRef, MetadataText} from "../src/surface/templates/CodeTypes.sol";

/// @notice Shared deploy step for the anton work's stateless art contracts.
///         Used by every anton script (DeployAntonRenderer, DeployAntonWork,
///         SwapAntonRenderer) so the store + renderer deploy exists once.
abstract contract AntonDeploy is Script {
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";
    string constant METADATA_FILE = "script/anton-metadata.json";

    /// @dev Shared local/fork path. Live deployments call the two steps
    ///      separately so each broadcast can be checked before sending.
    function deployAntonRenderer(address renderAssets) internal returns (address store, address renderer) {
        store = deployAntonStore();
        renderer = deployAntonRendererFromStore(store, renderAssets);
    }

    function deployAntonStore() internal returns (address store) {
        // Scripty stores serve base64 TEXT (the EthFS convention).
        bytes memory scriptB64 = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));
        store = address(new AntonScriptStore(scriptB64));
    }

    function deployAntonRendererFromStore(address store, address renderAssets) internal returns (address renderer) {
        assertAntonStore(store);
        require(renderAssets.code.length > 0, "RENDER_ASSETS has no code");
        // An older RenderAssets deployment lacks these getters. Binding to it
        // would make every Anton tokenURI and contractURI revert.
        try RenderAssets(renderAssets).tokenDescriptionOf(address(this)) returns (string memory) {}
        catch { revert("RENDER_ASSETS lacks editable text"); }
        try RenderAssets(renderAssets).collectionDescriptionOf(address(this)) returns (string memory) {}
        catch { revert("RENDER_ASSETS lacks editable text"); }
        try RenderAssets(renderAssets).externalUrlOf(address(this)) returns (string memory) {}
        catch { revert("RENDER_ASSETS lacks editable text"); }

        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        renderer = address(
            new AntonRenderer(
                SCRIPTY_BUILDER_V2,
                ETHFS_V2_FILE_STORAGE,
                GUNZIP_FILE,
                code,
                new CodeRef[](0),
                1,
                renderAssets,
                _readMetadataText()
            )
        );
    }

    function assertAntonStore(address store) internal view {
        require(store.code.length > 0, "ANTON_STORE has no code");
        bytes memory expected = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));
        bytes memory actual = AntonScriptStore(store).getContent("anton.js", "");
        require(keccak256(actual) == keccak256(expected), "ANTON_STORE content mismatch");
    }

    function assertAntonRenderer(address renderer, address store, address renderAssets) internal view {
        require(renderer.code.length > 0, "ANTON_RENDERER has no code");
        assertAntonStore(store);
        AntonRenderer art = AntonRenderer(renderer);
        require(address(art.renderAssets()) == renderAssets, "ANTON_RENDERER assets mismatch");
        require(address(art.scriptyBuilder()) == SCRIPTY_BUILDER_V2, "ANTON_RENDERER builder mismatch");
        require(art.gunzipStore() == ETHFS_V2_FILE_STORAGE, "ANTON_RENDERER gunzip mismatch");
        require(art.injectionVersion() == 1, "ANTON_RENDERER version mismatch");
        CodeRef[] memory code = art.code();
        require(
            code.length == 1 && code[0].store == store && code[0].kind == CodeKind.ScriptGzip
                && keccak256(bytes(code[0].name)) == keccak256(bytes("anton.js")),
            "ANTON_RENDERER store mismatch"
        );
    }

    function _readMetadataText() internal view returns (MetadataText memory) {
        string memory json = vm.readFile(METADATA_FILE);
        return MetadataText({
            tokenDescription: vm.parseJsonString(json, ".tokenDescription"),
            collectionDescription: vm.parseJsonString(json, ".collectionDescription"),
            externalUrl: vm.parseJsonString(json, ".externalUrl")
        });
    }
}
