// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {DefaultRenderer} from "../../../src/surface/renderers/DefaultRenderer.sol";
import {RenderAssets} from "../../../src/surface/renderers/RenderAssets.sol";
import {ISurfaceView} from "../../../src/surface/interfaces/IRenderer.sol";
import {SurfaceConfig, IdMode} from "../../../src/surface/SurfaceTypes.sol";

/// @dev Load-bearing compat test: v1's DefaultRenderer + RenderAssets, wired
///      against a real SurfaceV2 collection with no modification. v2 keeps
///      v1's exact ISurfaceView read selectors and return shapes
///      (docs/pnd-surface-v2-plan.md, "what v2 keeps unchanged") specifically
///      so v1 renderers work against v2 collections unmodified; this is what
///      that claim rests on.
contract SurfaceV2RendererCompatTest is Test {
    DefaultRenderer internal renderer;
    RenderAssets internal assets;
    SurfaceV2 internal impl;
    FixedPriceMinterV2 internal minterImpl;
    SurfaceFactoryV2 internal factory;
    SurfaceV2 internal collection;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    string internal constant ARTWORK = "ipfs://QmSurfaceV2Artwork";

    function setUp() public {
        assets = new RenderAssets();
        renderer = new DefaultRenderer(address(assets));
        impl = new SurfaceV2();
        minterImpl = new FixedPriceMinterV2();
        factory = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(0));

        SurfaceConfig memory cfg;
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);

        collection = SurfaceV2(
            factory.createSurfaceCustom(
                "Test SurfaceV2", "TCOL2", artist, cfg, noMinters, address(0), noCreators, address(0)
            )
        );
        // Cover art lives in renderer-land: the collection owner writes it to
        // the RenderAssets registry, same auth root (owner-or-admin) as v1.
        vm.prank(artist);
        assets.setCover(address(collection), ARTWORK);
        vm.prank(artist);
        collection.setMinter(address(this), true);
    }

    function _mint() internal returns (uint256 tokenId) {
        collection.mintTo(collector, 1);
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

    // ── tokenURI through the real v1 DefaultRenderer ─────────────────────────

    function test_tokenURI_isValidDataUri() public {
        uint256 tokenId = _mint();
        string memory uri = collection.tokenURI(tokenId);

        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");

        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name"'), "missing name key");
        assertTrue(_contains(json, '"description"'), "missing description key");
        assertTrue(_contains(json, '"image"'), "missing image key");
        assertTrue(_contains(json, '"attributes"'), "missing attributes key");
        assertTrue(_contains(json, "Test SurfaceV2 #1"), "wrong name value");
        assertTrue(_contains(json, ARTWORK), "expected collection cover in image field");
    }

    function test_tokenURI_markAttributes_firstMint() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(json, '"trait_type":"Mint Order","value":1'), "wrong Mint Order");
        assertTrue(
            _contains(json, '"trait_type":"Provenance","value":"First mint of the collection"'),
            "missing First mint provenance"
        );
    }

    function test_contractURI_isValidDataUriWithCover() public view {
        string memory uri = collection.contractURI();
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");
        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name":"Test SurfaceV2"'), "wrong contractURI name");
        assertTrue(_contains(json, string.concat('"image":"', ARTWORK, '"')), "cover appears in contractURI");
    }

    // ── ISurfaceView reads through the v1 interface, against v2 storage ──────

    function test_ISurfaceView_readsThroughV1Interface() public {
        uint256 tokenId = _mint();
        ISurfaceView cv = ISurfaceView(address(collection));

        assertEq(cv.name(), "Test SurfaceV2");
        assertEq(cv.symbol(), "TCOL2");
        assertEq(cv.owner(), artist);
        assertEq(cv.totalSupply(), 1);
        assertEq(cv.tokenSeed(tokenId), collection.tokenSeed(tokenId));

        (SurfaceConfig memory cfg, uint256 minted) = cv.config();
        assertEq(minted, 1);
        assertEq(cfg.renderer, address(renderer));

        assertEq(uint8(cv.idMode()), uint8(IdMode.Sequential), "compat shim always reports Sequential");
    }
}
