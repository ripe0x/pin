// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {AntonDeploy} from "../../../script/AntonDeploy.sol";
import {RenderAssets} from "../../../src/surface/renderers/RenderAssets.sol";
import {ISurfaceCore} from "../../../src/surface/interfaces/ISurfaceCore.sol";
import {ISurfaceAuth} from "../../../src/surface/interfaces/ISurfaceAuth.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";
import {Surface} from "../../../src/surface/Surface.sol";
import {ScriptyRenderer} from "../../../src/surface/templates/ScriptyRenderer.sol";
import {CodeKind, CodeRef, MetadataText} from "../../../src/surface/templates/CodeTypes.sol";

contract AntonDeployHarness is AntonDeploy {
    function deploy(address assets) external returns (address store, address renderer) {
        return deployAntonRenderer(assets);
    }

    function fromStore(address store, address assets) external returns (address renderer) {
        return deployAntonRendererFromStore(store, assets);
    }

    function verify(address renderer, address store, address assets) external {
        assertAntonRenderer(renderer, store, assets);
    }
}

contract AntonSepoliaForkTest is Test {
    address constant COLLECTION = 0xE95F98179a6365881aed0cb5331D96976E9Fe09b;
    address constant OWNER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    address constant OLD_ASSETS = 0xF314c0CAA5E3f55e1046626D1CAdF511c127423F;
    address constant OLD_STORE = 0xD6b2bAf7e617B08B0B5E46a90971F23954D508Be;

    function test_liveCollectionCanUseV3AndEditableText() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blockNumber = vm.envUint("ANTON_FORK_BLOCK");
        vm.createSelectFork(rpc, blockNumber);

        ISurfaceCore collection = ISurfaceCore(COLLECTION);
        (,, address royaltyReceiver, address oldRenderer, bool rendererLocked, bool supplyLocked) = _config(collection);
        assertEq(ISurfaceAuth(COLLECTION).owner(), OWNER);
        assertEq(royaltyReceiver, OWNER);
        assertFalse(rendererLocked);
        assertFalse(supplyLocked);

        RenderAssets assets = new RenderAssets();
        RenderAssets oldAssets = RenderAssets(OLD_ASSETS);
        string memory template = oldAssets.templateOf(COLLECTION);
        uint256 templateMax = oldAssets.templateMaxTokenIdOf(COLLECTION);
        vm.prank(OWNER);
        assets.setCaptureTemplate(COLLECTION, template, templateMax);
        for (uint256 id = 1; id <= 25; id++) {
            assertEq(assets.imageFor(COLLECTION, id), oldAssets.imageFor(COLLECTION, id));
        }
        AntonDeployHarness harness = new AntonDeployHarness();
        (address store, address renderer) = harness.deploy(address(assets));
        vm.expectRevert(bytes("RENDER_ASSETS lacks editable text"));
        harness.fromStore(store, OLD_ASSETS);
        vm.expectRevert(bytes("ANTON_STORE content mismatch"));
        harness.fromStore(OLD_STORE, address(assets));
        harness.verify(renderer, store, address(assets));
        vm.expectRevert(bytes("ANTON_RENDERER assets mismatch"));
        harness.verify(renderer, store, OLD_ASSETS);
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        ScriptyRenderer generic = new ScriptyRenderer(
            0xD7587F110E08F4D120A231bA97d3B577A81Df022,
            0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245,
            "gunzipScripts-0.0.1.js",
            code,
            new CodeRef[](0),
            1,
            address(assets),
            MetadataText({tokenDescription: "", collectionDescription: "", externalUrl: ""})
        );
        vm.expectRevert(bytes("ANTON_RENDERER bytecode mismatch"));
        harness.verify(address(generic), store, address(assets));

        vm.startPrank(OWNER);
        collection.setRenderer(renderer);
        collection.setSupplyCap(256);
        vm.stopPrank();
        assertEq(collection.renderer(), renderer);
        assertTrue(renderer != oldRenderer);
        (uint256 supplyCap,,,,,) = _config(collection);
        assertEq(supplyCap, 256);

        string memory tokenJson = _decode(Surface(COLLECTION).tokenURI(1));
        assertTrue(_has(tokenJson, '"trait_type":"Palette"'));
        assertTrue(_has(tokenJson, '"trait_type":"Mode"'));
        assertTrue(_has(tokenJson, '"trait_type":"Flow"'));
        assertTrue(_has(tokenJson, "animation_url"));
        assertTrue(_has(_decode(Surface(COLLECTION).contractURI()), "Every ending holds"));

        vm.prank(OWNER);
        assets.setText(COLLECTION, "Revised token", "Revised collection", "https://example.org");
        assertTrue(_has(_decode(Surface(COLLECTION).tokenURI(1)), "Revised token"));
        string memory revisedCollection = _decode(Surface(COLLECTION).contractURI());
        assertTrue(_has(revisedCollection, "Revised collection"));
        assertTrue(_has(revisedCollection, "https://example.org"));
    }

    function _config(ISurfaceCore collection)
        private
        view
        returns (uint256, uint16, address, address, bool, bool)
    {
        (SurfaceConfig memory cfg,) = collection.config();
        return (cfg.supplyCap, cfg.royaltyBps, cfg.royaltyReceiver, cfg.renderer, cfg.rendererLocked, cfg.supplyLocked);
    }

    function _decode(string memory uri) private pure returns (string memory) {
        return string(Base64.decode(LibString.slice(uri, bytes("data:application/json;base64,").length)));
    }

    function _has(string memory haystack, string memory needle) private pure returns (bool) {
        return LibString.indexOf(haystack, needle) != LibString.NOT_FOUND;
    }
}
