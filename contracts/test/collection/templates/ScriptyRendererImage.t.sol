// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {PooledCollection} from "../../../src/collection/PooledCollection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {RenderAssets} from "../../../src/collection/renderers/RenderAssets.sol";
import {ScriptyRenderer} from "../../../src/collection/templates/ScriptyRenderer.sol";
import {CodeKind, CodeRef} from "../../../src/collection/templates/CodeTypes.sol";
import {HTMLRequest} from "../../../src/collection/templates/vendor/scripty/core/ScriptyStructs.sol";
import {CollectionConfig} from "../../../src/collection/CollectionTypes.sol";
import {MockRenderer} from "../mocks/CollectionMocks.sol";

/// @dev Stands in for ScriptyBuilderV2 so the image plumbing can be unit
///      tested without a mainnet fork; document assembly itself is proven by
///      ScriptyRendererFork.t.sol against the real builder.
contract MockScriptyBuilder {
    function getEncodedHTMLString(HTMLRequest memory) external pure returns (string memory) {
        return "data:text/html;base64,bW9jaw==";
    }
}

/// @notice ScriptyRenderer's static-image wiring: with a RenderAssets
///         registry the metadata `image` resolves through the capture ladder;
///         without one there is no image at all and `animation_url` stands
///         alone. contractURI carries the cover the same way.
contract ScriptyRendererImageTest is Test {
    RenderAssets internal assets;
    Collection internal collection;
    ScriptyRenderer internal wired;
    ScriptyRenderer internal unwired;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    function setUp() public {
        assets = new RenderAssets();

        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(this), name: "sketch.js", kind: CodeKind.Script});
        CodeRef[] memory deps = new CodeRef[](0);
        address builder = address(new MockScriptyBuilder());

        wired = new ScriptyRenderer(builder, address(0), "", code, deps, 1, address(assets));
        unwired = new ScriptyRenderer(builder, address(0), "", code, deps, 1, address(0));

        Collection impl = new Collection();
        CollectionFactory factory = new CollectionFactory(
            address(impl), address(new PooledCollection()), address(new MockRenderer()), address(0)
        );
        CollectionConfig memory cfg;
        collection = Collection(
            factory.createCollection("Scripty Work", "SW", artist, cfg, new address[](0), new address[](0))
        );
        vm.prank(collector);
        collection.mint(1); // token 1 exists, seed stamped

        vm.prank(artist);
        assets.setCover(address(collection), "ipfs://scripty-cover");
    }

    function _json(string memory uri) internal pure returns (string memory) {
        return string(Base64.decode(LibString.slice(uri, 29, bytes(uri).length)));
    }

    function test_image_readsRenderAssetsLadder() public {
        string memory json = _json(wired.tokenURI(address(collection), 1));
        assertTrue(LibString.contains(json, '"image":"ipfs://scripty-cover"'), "cover floor via RenderAssets");

        vm.prank(artist);
        assets.setCaptureTemplate(address(collection), "ar://m/{id}.png");
        json = _json(wired.tokenURI(address(collection), 1));
        assertTrue(LibString.contains(json, '"image":"ar://m/1.png"'), "template rung resolves");
        assertTrue(LibString.contains(json, '"animation_url":"data:text/html;base64,'), "animation_url intact");
    }

    function test_image_absentWhenUnwired() public view {
        string memory json = _json(unwired.tokenURI(address(collection), 1));
        assertFalse(LibString.contains(json, '"image"'), "no registry, no image key");
        assertTrue(LibString.contains(json, '"animation_url"'), "animation_url stands alone");
    }

    function test_contractURI_coverWhenWired() public view {
        string memory json = _json(wired.contractURI(address(collection)));
        assertTrue(LibString.contains(json, '"image":"ipfs://scripty-cover"'), "cover in contractURI");

        string memory bare = _json(unwired.contractURI(address(collection)));
        assertFalse(LibString.contains(bare, '"image"'), "unwired contractURI has no image");
    }

    /// @dev previewURI needs no token: id 999 was never minted (tokenSeed is
    ///      never read), and preview metadata is deliberately not token-shaped
    ///      — name marked, seed attribute only, and NO static image even when
    ///      RenderAssets is wired (a preview is the live render).
    function test_previewURI_rendersUnminted_noImage_notTokenShaped() public view {
        string memory json = _json(wired.previewURI(address(collection), 999, keccak256("what-if")));

        assertTrue(LibString.contains(json, "(preview)"), "name marked as preview");
        assertTrue(LibString.contains(json, '"animation_url"'), "live render attached");
        assertTrue(LibString.contains(json, '"trait_type":"Seed"'), "seed attribute present");
        assertFalse(LibString.contains(json, '"image"'), "no static image on a preview, even wired");
        assertFalse(LibString.contains(json, "Mint Order"), "no provenance attributes");
    }
}
