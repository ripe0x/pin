// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../../../src/surface/minters/FixedPriceMinter.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";

import {RenderAssets} from "../../../src/surface/renderers/RenderAssets.sol";
import {BatchRenderRouter} from "../../../src/surface/renderers/BatchRenderRouter.sol";
import {ScriptyRenderer} from "../../../src/surface/templates/ScriptyRenderer.sol";
import {CodeKind, CodeRef} from "../../../src/surface/templates/CodeTypes.sol";
import {HTMLRequest, HTMLTag} from "../../../src/surface/templates/vendor/scripty/core/ScriptyStructs.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

import {MockSeedSourceV2} from "./mocks/SurfaceV2Mocks.sol";

/// @dev Stands in for ScriptyBuilderV2 without a mainnet fork: it echoes each
///      tag's content back into the document instead of assembling real
///      script tags. The real builder's assembly is proven against mainnet in
///      ScriptyRendererFork.t.sol; this test compares two renderer calls
///      against each other, so a builder that reflects its input is enough to
///      show where the two calls' output diverges.
contract EchoScriptyBuilder {
    function getEncodedHTMLString(HTMLRequest memory req) external pure returns (string memory) {
        bytes memory out;
        for (uint256 i = 0; i < req.headTags.length; i++) {
            out = abi.encodePacked(out, req.headTags[i].tagContent);
        }
        for (uint256 i = 0; i < req.bodyTags.length; i++) {
            out = abi.encodePacked(out, req.bodyTags[i].name, req.bodyTags[i].tagContent);
        }
        return string(abi.encodePacked("data:text/html;base64,", Base64.encode(out)));
    }
}

/// @title SurfaceV2ScriptyCompatTest
/// @notice Paired-fixture proof that ScriptyRenderer and RenderAssets serve a
///         SurfaceV2 collection the same way they serve a v1 Surface
///         collection: one renderer instance and one RenderAssets singleton
///         wired to both a v1 and a v2 collection with identical name,
///         symbol, config, and creators.
contract SurfaceV2ScriptyCompatTest is Test {
    using LibString for uint256;
    using LibString for address;
    using LibString for string;

    string constant ARTIST_FILE = "sketch.js";

    RenderAssets internal assets;
    ScriptyRenderer internal renderer;

    Surface internal v1Collection;
    SurfaceV2 internal v2Collection;
    SurfaceFactoryV2 internal v2Factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        assets = new RenderAssets();

        address builder = address(new EchoScriptyBuilder());
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(this), name: ARTIST_FILE, kind: CodeKind.Script});
        renderer = new ScriptyRenderer(builder, address(0), "", code, new CodeRef[](0), 1, address(assets));

        SurfaceConfig memory cfg;

        Surface v1Impl = new Surface();
        SurfaceFactory v1Factory = new SurfaceFactory(
            address(v1Impl), address(new PooledSurface()), address(new FixedPriceMinter()), address(renderer), address(0)
        );
        v1Collection = Surface(
            v1Factory.createSurfaceCustom(
                "Same Work", "SW", artist, cfg, new address[](0), address(0), new address[](0)
            )
        );

        SurfaceV2 v2Impl = new SurfaceV2();
        v2Factory = new SurfaceFactoryV2(address(v2Impl), address(new FixedPriceMinterV2()), address(renderer), address(0));
        v2Collection = SurfaceV2(
            v2Factory.createSurfaceCustom(
                "Same Work", "SW", artist, cfg, new address[](0), address(0), new address[](0), address(0)
            )
        );

        vm.prank(artist);
        v1Collection.setMinter(address(this), true);
        vm.prank(artist);
        v2Collection.setMinter(address(this), true);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _json(string memory dataUri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        return string(Base64.decode(LibString.slice(dataUri, bytes(prefix).length, bytes(dataUri).length)));
    }

    /// @dev Pulls the animation_url payload out of a decoded JSON document and
    ///      decodes its base64 HTML body.
    function _html(string memory json) internal pure returns (string memory) {
        string memory marker = '"animation_url":"data:text/html;base64,';
        uint256 start = LibString.indexOf(json, marker) + bytes(marker).length;
        uint256 end = LibString.indexOf(json, '"', start);
        return string(Base64.decode(LibString.slice(json, start, end)));
    }

    // ── tokenURI parity ──────────────────────────────────────────────────────

    /// @notice Same seed, same collection config, mounted on the same
    ///         renderer: the assembled documents differ only in the injected
    ///         collection address (docs/injection-convention.md's
    ///         `tokenData.collection` field). Normalizing that address out of
    ///         both documents proves the rest of the assembly is identical.
    function test_tokenURI_v2MatchesV1ForSameSeed() public {
        v1Collection.mintTo(collector, 1);
        bytes32 seed = v1Collection.tokenSeed(1);

        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = seed;
        v2Collection.mintToSeeded(collector, seeds);
        assertEq(v2Collection.tokenSeed(1), seed, "seeded token carries the exact supplied seed");

        string memory v1Html = _html(_json(v1Collection.tokenURI(1)));
        string memory v2Html = _html(_json(v2Collection.tokenURI(1)));

        string memory v1Addr = address(v1Collection).toHexString();
        string memory v2Addr = address(v2Collection).toHexString();

        assertTrue(LibString.contains(v1Html, v1Addr), "v1 document carries the v1 collection address");
        assertTrue(LibString.contains(v2Html, v2Addr), "v2 document carries the v2 collection address");
        assertFalse(LibString.contains(v1Html, v2Addr), "v1 document does not carry the v2 address");
        assertFalse(LibString.contains(v2Html, v1Addr), "v2 document does not carry the v1 address");

        string memory placeholder = "COLLECTION";
        string memory v1Normalized = LibString.replace(v1Html, v1Addr, placeholder);
        string memory v2Normalized = LibString.replace(v2Html, v2Addr, placeholder);
        assertEq(v1Normalized, v2Normalized, "assembled documents match once the collection address is normalized");
    }

    /// @notice previewURI needs no minted token: the same collection,
    ///         tokenId, and seed assemble the same document for v1 and v2.
    ///         Normalization: replace each collection's own address with a
    ///         shared placeholder before comparing, the same substitution
    ///         `test_tokenURI_v2MatchesV1ForSameSeed` uses, since the
    ///         injected `tokenData.collection` field is the one value the
    ///         two renderer calls are expected to differ on.
    function test_previewURI_v2MatchesV1ForSameSeed() public {
        bytes32 seed = keccak256("preview-parity");
        uint256 tokenId = 7;

        string memory v1Html = _html(_json(renderer.previewURI(address(v1Collection), tokenId, seed)));
        string memory v2Html = _html(_json(renderer.previewURI(address(v2Collection), tokenId, seed)));

        string memory v1Addr = address(v1Collection).toHexString();
        string memory v2Addr = address(v2Collection).toHexString();
        string memory placeholder = "COLLECTION";

        string memory v1Normalized = LibString.replace(v1Html, v1Addr, placeholder);
        string memory v2Normalized = LibString.replace(v2Html, v2Addr, placeholder);
        assertEq(v1Normalized, v2Normalized, "preview documents match once the collection address is normalized");
    }

    /// @notice A plain mintTo on v2 derives a seed the same way v1 does
    ///         (docs/pnd-surface-v2-plan.md's seed formula drops mintIndex,
    ///         keeping prevrandao + collection + tokenId), and the resulting
    ///         document is a complete, decodable HTML document.
    function test_tokenURI_v2DerivedSeedRendersValidDocument() public {
        v2Collection.mintTo(collector, 1);
        bytes32 seed = v2Collection.tokenSeed(1);
        assertTrue(seed != bytes32(0), "derived seed is nonzero");

        string memory uri = v2Collection.tokenURI(1);
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"), "json data uri prefix");

        string memory json = _json(uri);
        assertTrue(LibString.contains(json, '"animation_url":"data:text/html;base64,'), "animation_url present");
        assertTrue(LibString.contains(json, '"trait_type":"Mint Order","value":1'), "mint order trait");

        string memory expectedHash =
            string(abi.encodePacked('window.tokenData={"hash":"', uint256(seed).toHexString(32)));
        string memory html = _html(json);
        assertTrue(LibString.contains(html, expectedHash), "derived seed injected into the document");
        // Body tag order is deps, then the context script, then code: with no
        // deps the context precedes the artist file's name in the document.
        assertTrue(LibString.contains(html, ARTIST_FILE), "artist code tag present");
    }

    // ── seedSource fallback ──────────────────────────────────────────────────

    /// @notice A collection initialized with a seedSource serves tokenSeed
    ///         from the source for a token with no stored seed, and the
    ///         source's seed is what the rendered document injects. A
    ///         minter-supplied nonzero seed via mintToSeeded is stored and
    ///         takes precedence over the source for that token, again
    ///         reflected in the rendered document.
    function test_tokenURI_v2SeedSourceBackedRendersSourceSeed() public {
        MockSeedSourceV2 source = new MockSeedSourceV2();
        SurfaceConfig memory cfg;
        SurfaceV2 sourced = SurfaceV2(
            v2Factory.createSurfaceCustom(
                "Sourced Work", "SRC", artist, cfg, new address[](0), address(0), new address[](0), address(source)
            )
        );
        vm.prank(artist);
        sourced.setMinter(address(this), true);

        bytes32 sourceSeed = keccak256("from-source");
        source.setSeed(address(sourced), 1, sourceSeed);

        sourced.mintTo(collector, 1);
        assertEq(sourced.tokenSeed(1), sourceSeed, "unstored seed falls back to the source");

        string memory sourceHtml = _html(_json(sourced.tokenURI(1)));
        string memory expectedSourceHash =
            string(abi.encodePacked('window.tokenData={"hash":"', uint256(sourceSeed).toHexString(32)));
        assertTrue(LibString.contains(sourceHtml, expectedSourceHash), "source seed injected into the document");

        bytes32[] memory suppliedSeeds = new bytes32[](1);
        suppliedSeeds[0] = keccak256("minter-supplied");
        sourced.mintToSeeded(collector, suppliedSeeds);
        assertEq(sourced.tokenSeed(2), suppliedSeeds[0], "minter-supplied seed wins over the source");

        string memory suppliedHtml = _html(_json(sourced.tokenURI(2)));
        string memory expectedSuppliedHash =
            string(abi.encodePacked('window.tokenData={"hash":"', uint256(suppliedSeeds[0]).toHexString(32)));
        assertTrue(
            LibString.contains(suppliedHtml, expectedSuppliedHash), "minter-supplied seed injected into the document"
        );
    }

    // ── contractURI parity ───────────────────────────────────────────────────

    /// @notice contractURI encodes the collection name and cover text. With
    ///         the same cover set for both collections, the decoded documents
    ///         are byte-equal directly, with no address substitution needed.
    function test_contractURI_v2MatchesV1() public {
        string memory cover = "ipfs://same-cover";
        vm.prank(artist);
        assets.setCover(address(v1Collection), cover);
        vm.prank(artist);
        assets.setCover(address(v2Collection), cover);

        string memory v1Json = _json(v1Collection.contractURI());
        string memory v2Json = _json(v2Collection.contractURI());
        assertEq(v1Json, v2Json, "contractURI is byte identical for matching name and cover");
        assertTrue(LibString.contains(v1Json, cover), "cover present in contractURI");
    }

    // ── RenderAssets.imageFor resolution order ──────────────────────────────

    /// @notice The capture ladder (explicit capture, then template, then
    ///         cover, then empty) resolves the same way for a v2 collection as
    ///         for a v1 collection. Asserted against both collections in the
    ///         same test so the two resolution orders sit side by side.
    function test_imageFor_resolutionOrder_v2() public {
        _assertResolutionOrder(address(v1Collection), artist);
        _assertResolutionOrder(address(v2Collection), artist);
    }

    function _assertResolutionOrder(address collection, address owner_) internal {
        assertEq(assets.imageFor(collection, 1), "", "no cover, no template, no capture: empty");

        vm.prank(owner_);
        assets.setCover(collection, "ipfs://cover");
        assertEq(assets.imageFor(collection, 1), "ipfs://cover", "cover floor");

        vm.prank(owner_);
        assets.setCaptureTemplate(collection, "ar://m/{id}.png");
        assertEq(assets.imageFor(collection, 1), "ar://m/1.png", "template beats cover");

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        string[] memory uris = new string[](1);
        uris[0] = "ar://m/explicit.png";
        vm.prank(owner_);
        assets.setCaptures(collection, ids, uris);
        assertEq(assets.imageFor(collection, 1), "ar://m/explicit.png", "explicit capture beats template");
    }

    // ── RenderAssets authority on a v2 collection ───────────────────────────

    /// @notice RenderAssets borrows the collection's own owner-or-admin
    ///         authority (ISurfaceAuth). A v2 collection's owner and an admin
    ///         granted via v2's addAdmin can write the cover; an unrelated
    ///         account cannot.
    function test_renderAssetsAuth_v2OwnerAndAdmin() public {
        vm.prank(artist);
        assets.setCover(address(v2Collection), "ipfs://owner-set");
        assertEq(assets.coverOf(address(v2Collection)), "ipfs://owner-set");

        vm.prank(artist);
        v2Collection.addAdmin(admin);
        vm.prank(admin);
        assets.setCover(address(v2Collection), "ipfs://admin-set");
        assertEq(assets.coverOf(address(v2Collection)), "ipfs://admin-set");

        vm.prank(stranger);
        vm.expectRevert(RenderAssets.NotSurfaceAdmin.selector);
        assets.setCover(address(v2Collection), "ipfs://stranger-set");
    }

    // ── BatchRenderRouter dispatch ───────────────────────────────────────────

    /// @notice BatchRenderRouter maps an id range to a renderer; every call
    ///         takes the collection as an argument. A v2 collection's
    ///         tokenURI resolves through the router the same way v1's does.
    function test_batchRenderRouter_resolvesV2SameAsV1() public {
        v1Collection.mintTo(collector, 1);
        v2Collection.mintTo(collector, 1);

        BatchRenderRouter router = new BatchRenderRouter();
        router.addBatch(1, 10, address(renderer), "batch 1");

        assertEq(
            router.tokenURI(address(v1Collection), 1),
            renderer.tokenURI(address(v1Collection), 1),
            "router matches direct renderer call for v1"
        );
        assertEq(
            router.tokenURI(address(v2Collection), 1),
            renderer.tokenURI(address(v2Collection), 1),
            "router matches direct renderer call for v2"
        );
    }
}
