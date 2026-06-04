// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDEditionsMuriOperator} from "../../src/editions/PNDEditionsMuriOperator.sol";
import {PNDMuriRenderer} from "../../src/editions/PNDMuriRenderer.sol";
import {IMURIProtocol} from "../../src/editions/interfaces/IMURIProtocol.sol";
import {IMURIProtocolCreator} from "../../src/editions/interfaces/IMURIProtocolCreator.sol";

/// @notice Fork test for the editions-on-MURI anchor path, run against the REAL
///         immutable MURIProtocol singleton on mainnet. Verifies the full
///         artist flow (registerContract -> anchor -> setRenderer), that MURI
///         stored the fallback array + hash, that the opt-in renderer sources
///         the artwork from MURI (with graceful pre-anchor fallback), and that
///         the operator's isTokenOwner correctly gates collector fallbacks.
///
///         RPC: a free public endpoint, inlined per the repo's fork-RPC policy
///         (do not burn the paid key on forks). Forks at HEAD, so it reads
///         MURI's current state; if no network is available the suite skips
///         rather than failing. Run:
///           cd contracts && forge test --match-path "test/editions/PNDEditionsMuri.t.sol" -vv
contract PNDEditionsMuriTest is PNDEditionsBase {
    // MURIProtocol mainnet singleton (immutable; ygtdmn/muri-protocol).
    address internal constant MURI = 0x0000000000C2A0B63ab4aA971B08B905E5875b01;
    string internal constant FORK_RPC = "https://ethereum-rpc.publicnode.com";

    PNDEditionsMuriOperator internal operator;
    PNDMuriRenderer internal muriRenderer;
    bool internal forked;

    // Two independent fallback URIs for the same content-addressed artwork.
    string internal constant URI_A = "https://arweave.net/TESTtxidTESTtxidTESTtxidTESTtxidTESTtxi";
    string internal constant URI_B = "https://ipfs.io/ipfs/QmTestContentTestContentTestContentXY";
    string internal constant FILE_HASH =
        "0x1111111111111111111111111111111111111111111111111111111111111111";

    function setUp() public override {
        try vm.createSelectFork(FORK_RPC) {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        // MURIProtocol must actually be present at the pinned/HEAD state.
        if (MURI.code.length == 0) {
            forked = false;
            return;
        }
        super.setUp(); // deploys renderer/impl/factory on the fork
        operator = new PNDEditionsMuriOperator(MURI);
        muriRenderer = new PNDMuriRenderer(MURI);
    }

    /// @dev A fully off-chain MURI InitConfig: two fallback artwork URIs, a
    ///      SHA-256 hash, HTML display mode (the resilient onchain viewer), full
    ///      artist permissions + collector add/choose. Mirrors the web
    ///      buildInitConfig (apps/web/src/lib/muri/build-init-config.ts).
    function _config() internal pure returns (IMURIProtocol.InitConfig memory cfg) {
        string[] memory uris = new string[](2);
        uris[0] = URI_A;
        uris[1] = URI_B;

        cfg.metadata = '"name":"anchored"';
        cfg.artwork = IMURIProtocol.Artwork({
            artistUris: uris,
            collectorUris: new string[](0),
            mimeType: "image/png",
            fileHash: FILE_HASH,
            isAnimationUri: false,
            selectedArtistUriIndex: 0
        });
        cfg.thumbnail = IMURIProtocol.Thumbnail({
            kind: IMURIProtocol.ThumbnailKind.OFF_CHAIN,
            onChain: IMURIProtocol.OnChainThumbnail({mimeType: "", chunks: new address[](0), zipped: false}),
            offChain: IMURIProtocol.OffChainThumbnail({uris: uris, selectedUriIndex: 0})
        });
        cfg.displayMode = IMURIProtocol.DisplayMode.HTML;
        // ARTIST_ALL (bits 0-6 = 127) | COLLECTOR_CHOOSE_URIS (1<<7) | COLLECTOR_ADD_REMOVE (1<<8).
        cfg.permissions = IMURIProtocol.Permissions({flags: 511});
        cfg.htmlTemplate = IMURIProtocol.HtmlTemplate({chunks: new address[](0), zipped: false});
    }

    /// @dev Deploy an edition, mint token #1 to the collector, point it at the
    ///      MURI renderer, register it with MURI, and anchor the artwork.
    function _anchoredEdition() internal returns (PNDEditions p) {
        p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);

        vm.prank(artist);
        p.setRenderer(address(muriRenderer));

        vm.prank(artist);
        IMURIProtocol(MURI).registerContract(address(p), address(operator));

        vm.prank(artist);
        operator.anchor(address(p), _config());
    }

    // ── registration + anchor ───────────────────────────────────────────────

    function test_register_and_anchor_storesFallbacksAndHash() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _anchoredEdition();

        assertTrue(IMURIProtocol(MURI).isContractOperator(address(p), address(operator)));

        IMURIProtocol.Artwork memory art = IMURIProtocol(MURI).getArtwork(address(p), 0);
        assertEq(art.artistUris.length, 2, "two fallbacks stored");
        assertEq(art.artistUris[0], URI_A);
        assertEq(art.artistUris[1], URI_B);
        assertEq(art.fileHash, FILE_HASH, "integrity hash stored");

        // renderImage resolves to the selected fallback (off-chain thumbnail).
        assertEq(IMURIProtocol(MURI).renderImage(address(p), 0), URI_A);
        // The resilient onchain HTML viewer renders non-empty.
        assertGt(bytes(IMURIProtocol(MURI).renderHTML(address(p), 0)).length, 0);
    }

    function test_anchor_revertsForNonOwner() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _edition(_freeConfig());
        vm.prank(artist);
        IMURIProtocol(MURI).registerContract(address(p), address(operator));

        vm.prank(stranger);
        vm.expectRevert(PNDEditionsMuriOperator.NotEditionOwner.selector);
        operator.anchor(address(p), _config());
    }

    // ── renderer composition ──────────────────────────────────────────────────

    function test_renderer_fallsBackBeforeAnchor() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
        vm.prank(artist);
        p.setRenderer(address(muriRenderer));

        // Not anchored yet: tokenURI must still render (falls back to artwork()).
        string memory uri = p.tokenURI(1);
        assertGt(bytes(uri).length, 0, "renders pre-anchor");
    }

    function test_renderer_sourcesArtworkFromMuriAfterAnchor() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
        vm.prank(artist);
        p.setRenderer(address(muriRenderer));
        string memory before = p.tokenURI(1);

        vm.prank(artist);
        IMURIProtocol(MURI).registerContract(address(p), address(operator));
        vm.prank(artist);
        operator.anchor(address(p), _config());

        string memory afterAnchor = p.tokenURI(1);
        // Composition changed: MURI image + the (heavy) animation_url viewer make
        // the post-anchor metadata both different and longer than the fallback.
        assertTrue(
            keccak256(bytes(afterAnchor)) != keccak256(bytes(before)), "tokenURI changed after anchor"
        );
        assertGt(bytes(afterAnchor).length, bytes(before).length, "animation_url added");
    }

    // ── isTokenOwner / collector fallbacks ─────────────────────────────────────

    function test_isTokenOwner_canonicalIsAnyHolder() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _anchoredEdition();
        // Canonical id 0: any edition holder qualifies (balanceOf > 0).
        assertTrue(operator.isTokenOwner(address(p), collector, 0), "holder qualifies");
        assertFalse(operator.isTokenOwner(address(p), stranger, 0), "non-holder rejected");
        // A real tokenId: strict ownerOf.
        assertTrue(operator.isTokenOwner(address(p), collector, 1));
        assertFalse(operator.isTokenOwner(address(p), stranger, 1));
    }

    function test_collectorCanAddFallback_strangerCannot() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        PNDEditions p = _anchoredEdition();
        string[] memory add = new string[](1);
        add[0] = "https://w3s.link/ipfs/QmCollectorAddedCopyCollectorAddedCopy01";

        // A holder (collector) may contribute a fallback to the shared artwork.
        vm.prank(collector);
        IMURIProtocol(MURI).addArtworkUris(address(p), 0, add);
        string[] memory collectorUris = IMURIProtocol(MURI).getCollectorArtworkUris(address(p), 0);
        assertEq(collectorUris.length, 1);
        assertEq(collectorUris[0], add[0]);

        // A non-holder cannot.
        vm.prank(stranger);
        vm.expectRevert();
        IMURIProtocol(MURI).addArtworkUris(address(p), 0, add);
    }

    // ── ERC165 (registration gate) ──────────────────────────────────────────────

    function test_operator_supportsCreatorInterface() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertTrue(operator.supportsInterface(type(IMURIProtocolCreator).interfaceId));
    }
}
