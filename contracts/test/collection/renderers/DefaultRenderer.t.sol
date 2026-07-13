// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {PooledCollection} from "../../../src/collection/PooledCollection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {DefaultRenderer} from "../../../src/collection/renderers/DefaultRenderer.sol";
import {RenderAssets} from "../../../src/collection/renderers/RenderAssets.sol";
import {CollectionConfig, IdMode} from "../../../src/collection/CollectionTypes.sol";

/// @notice Output-shape tests for DefaultRenderer: tokenURI/contractURI shape,
///         image field (default vs per-token override), and provenance
///         provenance attributes. Deploys a real Collection via the
///         factory so the renderer is exercised against the actual
///         ICollectionView implementation, not a mock.
contract DefaultRendererTest is Test {
    DefaultRenderer internal renderer;
    RenderAssets internal assets;
    Collection internal impl;
    CollectionFactory internal factory;
    Collection internal collection;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    string internal constant ARTWORK = "ipfs://QmCollectionArtwork";

    function setUp() public {
        assets = new RenderAssets();
        renderer = new DefaultRenderer(address(assets));
        impl = new Collection();
        factory = new CollectionFactory(address(impl), address(new PooledCollection()), address(renderer), address(0));

        CollectionConfig memory cfg;
        cfg.price = 0; // gas-only mint
        cfg.supplyCap = 0;

        address[] memory noMinters = new address[](0);
        address[] memory noArtists = new address[](0);

        collection = Collection(factory.createCollection("Test Collection", "TCOL", artist, cfg, noMinters, noArtists));
        // Cover art lives in renderer-land: the collection owner writes it to
        // the RenderAssets registry.
        vm.prank(artist);
        assets.setCover(address(collection), ARTWORK);
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

    function test_tokenURI_image_perTokenCapture() public {
        uint256 tokenId = _mint();
        string memory capture = "ipfs://QmPerTokenCapture";

        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        string[] memory uris = new string[](1);
        uris[0] = capture;
        vm.prank(artist);
        assets.setCaptures(address(collection), ids, uris);

        string memory json = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(json, capture), "expected per-token capture in image field");
        assertFalse(_contains(json, ARTWORK), "cover should not appear once captured");
    }

    function test_renderAssets_authIsCollectionOwnerOrAdmin() public {
        // stranger cannot write assets for a collection they don't control
        address stranger = makeAddr("stranger");
        vm.expectRevert(RenderAssets.NotCollectionAdmin.selector);
        vm.prank(stranger);
        assets.setCover(address(collection), "ipfs://nope");

        // a collection admin can
        address admin = makeAddr("assetAdmin");
        vm.prank(artist);
        collection.addAdmin(admin);
        vm.prank(admin);
        assets.setCover(address(collection), "ipfs://QmByAdmin");
        assertEq(assets.coverOf(address(collection)), "ipfs://QmByAdmin");
    }

    // ── derived provenance attributes ────────────────────────────────────────

    function test_tokenURI_markAttributes_firstMint() public {
        uint256 tokenId = _mint();
        string memory json = _decode(collection.tokenURI(tokenId));

        // Mint Order is DERIVED: sequential token id IS the order. Mint Block
        // is no longer a trait (nothing per-token is stored beyond the seed).
        assertTrue(_contains(json, '"trait_type":"Mint Order","value":1'), "wrong Mint Order");
        assertFalse(_contains(json, '"trait_type":"Mint Block"'), "Mint Block trait was removed");
        // Referrer / Status at Mint are deliberately NOT traits: both are
        // event-only provenance on Minted, no longer stored per token.
        assertFalse(_contains(json, '"trait_type":"Referrer"'), "Referrer trait was removed");
        assertFalse(_contains(json, '"trait_type":"Status at Mint"'), "Status at Mint trait was removed");
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
        assertFalse(_contains(json, "First mint of the collection"), "second mint should not carry First provenance");
    }

    /// @dev Final provenance is derived live from status + minted count, so
    ///      it appears when the window closes and DISAPPEARS if the window
    ///      reopens — the un-finalize behavior that stored marks could never
    ///      express honestly.
    function test_tokenURI_finalProvenance_derivedAndReversible() public {
        vm.warp(1000);
        vm.prank(artist);
        collection.setMintWindow(0, uint64(block.timestamp + 100));
        uint256 tokenId = _mint();

        string memory open_ = _decode(collection.tokenURI(tokenId));
        assertFalse(_contains(open_, "Final mint of the collection"), "open: not final");

        vm.warp(block.timestamp + 100); // window ends -> derived Closed
        string memory closed = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(closed, "Final mint of the collection"), "closed: last minted token derives Final");

        vm.prank(artist);
        collection.setMintWindow(0, 0); // reopen
        string memory reopened = _decode(collection.tokenURI(tokenId));
        assertFalse(_contains(reopened, "Final mint of the collection"), "reopened: Final derives away");
    }

    function test_tokenURI_referrerIsNotATrait() public {
        address referrer = makeAddr("referrer");
        vm.prank(collector);
        collection.mintWithReferral(1, referrer, "");

        // referrer is event-only provenance (Minted); it must NOT leak into
        // token metadata.
        string memory json = _decode(collection.tokenURI(1));
        assertFalse(_contains(json, _toHexString(referrer)), "referrer must not appear in metadata");
    }

    /// @dev The template rung sits between explicit captures and the cover:
    ///      one write covers a whole drop's thumbnails.
    function test_tokenURI_image_templateRung() public {
        uint256 tokenId = _mint();
        vm.prank(artist);
        assets.setCaptureTemplate(address(collection), "ar://manifest/{id}.png");

        string memory json = _decode(collection.tokenURI(tokenId));
        assertTrue(_contains(json, "ar://manifest/1.png"), "template resolves with the token id");
        assertFalse(_contains(json, ARTWORK), "cover yields to the template");
    }

    // ── contractURI shape ────────────────────────────────────────────────────

    function test_contractURI_shape() public view {
        string memory uri = collection.contractURI();
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "wrong data URI prefix");
        string memory json = _decode(uri);
        assertTrue(_contains(json, '"name":"Test Collection"'), "wrong contractURI name");
    }

    /// @dev Contract-level metadata is the marketplace collection page; the
    ///      cover is its image.
    function test_contractURI_includesCover() public view {
        string memory json = _decode(collection.contractURI());
        assertTrue(_contains(json, string.concat('"image":"', ARTWORK, '"')), "cover appears in contractURI");
    }

    function test_contractURI_omitsImageWithoutCover() public {
        vm.prank(artist);
        assets.setCover(address(collection), "");
        string memory json = _decode(collection.contractURI());
        assertFalse(_contains(json, '"image"'), "no cover, no image key");
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
