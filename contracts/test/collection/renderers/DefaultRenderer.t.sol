// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {DefaultRenderer} from "../../../src/collection/renderers/DefaultRenderer.sol";
import {
    CollectionConfig,
    CollectionKind,
    IdMode,
    WorkConfig
} from "../../../src/collection/CollectionTypes.sol";

/// @notice Output-shape tests for DefaultRenderer: tokenURI/contractURI shape,
///         image field (default vs per-token override), and Mint Mark
///         provenance attributes. Deploys a real Collection via the
///         factory so the renderer is exercised against the actual
///         ICollectionView implementation, not a mock.
contract DefaultRendererTest is Test {
    DefaultRenderer internal renderer;
    Collection internal impl;
    CollectionFactory internal factory;
    Collection internal collection;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    string internal constant ARTWORK = "ipfs://QmCollectionArtwork";

    function setUp() public {
        renderer = new DefaultRenderer();
        impl = new Collection();
        factory = new CollectionFactory(address(impl), address(renderer), address(0));

        CollectionConfig memory cfg;
        cfg.artworkURI = ARTWORK;
        cfg.price = 0; // gas-only mint
        cfg.supplyCap = 0;
        cfg.kind = CollectionKind.Standalone;
        cfg.idMode = IdMode.Sequential;

        WorkConfig memory work; // empty: renderer-native / no onchain algorithm

        address[] memory noMinters = new address[](0);
        address[] memory noArtists = new address[](0);

        collection = Collection(
            factory.createCollection(
                "Test Collection", "TCOL", artist, cfg, work, noMinters, noArtists
            )
        );
    }

    // ── helpers ──────────────────────────────────────────────────────────────

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

    // ── tokenURI shape ───────────────────────────────────────────────────────

    function test_tokenURI_isBase64Json() public {
        uint256 tokenId = _mint();
        string memory uri = collection.tokenURI(tokenId);

        // data URI envelope
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");

        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name"'), "missing name key");
        assertTrue(_contains(json, '"description"'), "missing description key");
        assertTrue(_contains(json, '"image"'), "missing image key");
        assertTrue(_contains(json, '"attributes"'), "missing attributes key");
        assertTrue(_contains(json, "Test Collection #1"), "wrong name value");
    }

    function test_tokenURI_image_defaultsToCollectionArtwork() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(json, ARTWORK), "expected default collection artwork in image field");
    }

    function test_tokenURI_image_perTokenOverride() public {
        uint256 tokenId = _mint();
        string memory override_ = "ipfs://QmPerTokenOverride";

        vm.prank(artist);
        collection.setTokenArtwork(tokenId, override_);

        string memory json = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(json, override_), "expected per-token override in image field");
        assertFalse(_contains(json, ARTWORK), "collection artwork should not appear once overridden");
    }

    // ── Mint Mark provenance attributes ─────────────────────────────────────

    function test_tokenURI_markAttributes_firstMint() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));

        assertTrue(_contains(json, '"trait_type":"Mint Order","value":1'), "wrong Mint Order");
        assertTrue(_contains(json, '"trait_type":"Mint Block"'), "missing Mint Block");
        assertTrue(_contains(json, '"trait_type":"Referrer"'), "missing Referrer");
        assertTrue(
            _contains(json, '"trait_type":"Status at Mint","value":"Open"'),
            "wrong Status at Mint"
        );
        assertTrue(
            _contains(json, '"trait_type":"Provenance","value":"First mint of the collection"'),
            "missing First mint provenance"
        );
    }

    function test_tokenURI_markAttributes_secondMintIsNotFirst() public {
        _mint(); // token 1
        vm.prank(collector);
        collection.mint(1); // token 2
        string memory json = _decode(collection.tokenURI(2));

        assertTrue(_contains(json, '"trait_type":"Mint Order","value":2'), "wrong Mint Order");
        assertFalse(
            _contains(json, "First mint of the collection"),
            "second mint should not carry First provenance"
        );
    }

    function test_tokenURI_mintReferrer_reflectsReferrerParam() public {
        address referrer = makeAddr("referrer");
        vm.prank(collector);
        collection.mintWithReferral(1, referrer, "");

        string memory json = _decode(collection.tokenURI(1));
        // lowercase hex of the referrer address must appear as the trait value
        assertTrue(_contains(json, _toHexString(referrer)), "expected referrer address in attributes");
    }

    // ── contractURI shape ────────────────────────────────────────────────────

    function test_contractURI_shape() public view {
        string memory uri = collection.contractURI();
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");
        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name":"Test Collection"'), "wrong contractURI name");
    }

    // ── string test helpers ──────────────────────────────────────────────────

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
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

    function _toHexString(address a) internal pure returns (string memory) {
        bytes memory hexc = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(v >> (8 * (19 - i)));
            out[2 + i * 2] = hexc[b >> 4];
            out[3 + i * 2] = hexc[b & 0x0f];
        }
        return string(out);
    }
}
