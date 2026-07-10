// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {DefaultRenderer} from "../../../src/collection/renderers/DefaultRenderer.sol";
import {TestSVGRenderer} from "./TestSVGRenderer.sol";
import {CollectionConfig, IdMode} from "../../../src/collection/CollectionTypes.sol";
import {RenderAssets} from "../../../src/collection/renderers/RenderAssets.sol";

/// @notice Output-shape tests for the SVGRenderer abstract base, exercised
///         through TestSVGRenderer (a minimal seed-derived rect). Deploys a
///         real Collection via the factory, then swaps in the SVG
///         renderer as the collection's active renderer.
contract SVGRendererTest is Test {
    using LibString for uint256;

    DefaultRenderer internal defaultRenderer;
    TestSVGRenderer internal svgRenderer;
    Collection internal impl;
    CollectionFactory internal factory;
    Collection internal collection;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    function setUp() public {
        // The factory requires a defaultRenderer at deploy; the collection
        // then flips to the SVG renderer via setRenderer, same as an artist
        // choosing a generative/onchain work post-deploy.
        defaultRenderer = new DefaultRenderer(address(new RenderAssets()));
        svgRenderer = new TestSVGRenderer();
        impl = new Collection();
        factory =
            new CollectionFactory(address(impl), address(defaultRenderer), address(0));

        CollectionConfig memory cfg;
        cfg.price = 0;
        cfg.supplyCap = 0;
        cfg.idMode = IdMode.Sequential;

        address[] memory noMinters = new address[](0);
        address[] memory noArtists = new address[](0);

        collection = Collection(
            factory.createCollection(
                "SVG Collection", "SVGC", artist, cfg, noMinters, noArtists
            )
        );

        vm.prank(artist);
        collection.setRenderer(address(svgRenderer));
    }

    function _mint() internal returns (uint256 tokenId) {
        vm.prank(collector);
        collection.mint(1);
        tokenId = 1;
    }

    function _decode(string memory uri) internal pure returns (string memory json) {
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory u = bytes(uri);
        require(u.length > prefix.length, "uri too short");
        for (uint256 i = 0; i < prefix.length; i++) {
            require(u[i] == prefix[i], "bad prefix");
        }
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) {
            b64[i] = u[i + prefix.length];
        }
        return string(Base64.decode(string(b64)));
    }

    function _extractField(string memory json, string memory key)
        internal
        pure
        returns (string memory)
    {
        bytes memory j = bytes(json);
        bytes memory k = bytes(string.concat('"', key, '":"'));
        int256 start = -1;
        for (uint256 i = 0; i + k.length <= j.length; i++) {
            bool ok = true;
            for (uint256 x = 0; x < k.length; x++) {
                if (j[i + x] != k[x]) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                start = int256(i + k.length);
                break;
            }
        }
        require(start >= 0, "key not found");
        uint256 s = uint256(start);
        uint256 e = s;
        while (e < j.length && j[e] != '"') {
            e++;
        }
        bytes memory out = new bytes(e - s);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = j[s + i];
        }
        return string(out);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return n.length == 0;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    // ── envelope shape ───────────────────────────────────────────────────────

    function test_tokenURI_isBase64Json() public {
        uint256 tokenId = _mint();
        string memory uri = collection.tokenURI(tokenId);
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");

        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name"'), "missing name key");
        assertTrue(_contains(json, '"image"'), "missing image key");
        assertTrue(_contains(json, '"attributes"'), "missing attributes key");
        assertTrue(_contains(json, "SVG Collection #1"), "wrong default name");
    }

    function test_tokenURI_noDescription_fieldOmitted() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));
        // TestSVGRenderer does not override tokenDescription; base default is "".
        assertFalse(_contains(json, '"description"'), "description field should be omitted");
    }

    // ── image field: base64 svg envelope + seed-derived body ────────────────

    function test_tokenURI_image_isBase64Svg_andMatchesSeed() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));
        string memory image = _extractField(json, "image");

        assertTrue(_startsWith(image, "data:image/svg+xml;base64,"), "wrong image data URI prefix");

        bytes memory prefix = bytes("data:image/svg+xml;base64,");
        bytes memory imgBytes = bytes(image);
        bytes memory b64 = new bytes(imgBytes.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) {
            b64[i] = imgBytes[i + prefix.length];
        }
        string memory svgBody = string(Base64.decode(string(b64)));

        assertTrue(_contains(svgBody, "<svg"), "decoded image is not an svg document");
        assertTrue(_contains(svgBody, "<rect"), "expected rect element from TestSVGRenderer");

        bytes32 seed = collection.tokenSeed(tokenId);
        string memory expectedFill = LibString.toHexStringNoPrefix(uint256(seed) & 0xffffff, 3);
        assertTrue(
            _contains(svgBody, expectedFill), "svg fill did not match the token's tokenSeed"
        );
    }

    function test_tokenURI_differentTokens_differentSeeds_differentArt() public {
        _mint(); // token 1
        vm.prank(collector);
        collection.mint(1); // token 2

        string memory json1 = _decode(collection.tokenURI(1));
        string memory json2 = _decode(collection.tokenURI(2));

        string memory image1 = _extractField(json1, "image");
        string memory image2 = _extractField(json2, "image");

        assertFalse(
            keccak256(bytes(image1)) == keccak256(bytes(image2)),
            "distinct tokens should not render identical art (seed should differ)"
        );
    }

    // ── attributes: default Mint Mark provenance ────────────────────────────

    function test_tokenURI_defaultAttributes_areMintMarkProvenance() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));

        // Mint Order is DERIVED: sequential token id IS the order. Mint Block
        // is no longer a trait (nothing per-token is stored beyond the seed).
        assertTrue(_contains(json, '"trait_type":"Mint Order","value":1'), "wrong Mint Order");
        assertFalse(_contains(json, '"trait_type":"Mint Block"'), "Mint Block trait was removed");
        // Referrer / Status at Mint are deliberately NOT traits: both are
        // event-only provenance on Minted, no longer stored per token.
        assertFalse(_contains(json, '"trait_type":"Referrer"'), "Referrer trait was removed");
        assertFalse(
            _contains(json, '"trait_type":"Status at Mint"'), "Status at Mint trait was removed"
        );
        assertTrue(
            _contains(json, '"trait_type":"Provenance","value":"First mint of the collection"'),
            "missing First mint provenance"
        );
    }

    // ── contractURI shape ────────────────────────────────────────────────────

    function test_contractURI_shape() public view {
        string memory uri = collection.contractURI();
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");
        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name":"SVG Collection"'), "wrong contractURI name");
    }

    // ── previewURI (IPreviewRenderer) ────────────────────────────────────────

    function test_previewURI_rendersWithoutAnyMint() public view {
        // No token exists; a preview must still render from the supplied seed.
        bytes32 seed = keccak256("throwaway");
        string memory uri = svgRenderer.previewURI(address(collection), 1, seed);
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");

        string memory json = _decode(uri);
        assertTrue(_contains(json, "(preview)"), "preview name must be marked as a preview");

        // The art must derive from the caller's seed, same path as tokenURI.
        string memory image = _extractField(json, "image");
        bytes memory prefix = bytes("data:image/svg+xml;base64,");
        bytes memory u = bytes(image);
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) {
            b64[i] = u[i + prefix.length];
        }
        string memory svgBody = string(Base64.decode(string(b64)));
        string memory expectedFill =
            LibString.toHexStringNoPrefix(uint256(seed) & 0xffffff, 3);
        assertTrue(
            _contains(svgBody, expectedFill), "preview art did not derive from the supplied seed"
        );
    }

    function test_previewURI_realSeed_matchesTokenURIImage() public {
        // A preview with the token's actual seed IS the token's render.
        uint256 tokenId = _mint();
        bytes32 seed = collection.tokenSeed(tokenId);

        string memory tokenImage = _extractField(_decode(collection.tokenURI(tokenId)), "image");
        string memory previewImage = _extractField(
            _decode(svgRenderer.previewURI(address(collection), tokenId, seed)), "image"
        );
        assertEq(tokenImage, previewImage, "preview(realSeed) must equal the token render");
    }

    function test_previewURI_noProvenanceAttributes() public view {
        string memory json =
            _decode(svgRenderer.previewURI(address(collection), 1, keccak256("x")));
        assertTrue(_contains(json, '"trait_type":"Seed"'), "preview must carry its seed");
        assertFalse(
            _contains(json, '"trait_type":"Mint Order"'),
            "a preview is not a token: no provenance traits"
        );
        assertFalse(
            _contains(json, '"trait_type":"Provenance"'),
            "a preview is not a token: no provenance traits"
        );
    }
}
