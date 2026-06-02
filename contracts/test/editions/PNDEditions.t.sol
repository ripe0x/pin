// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {MockRenderer, RevertOnReceive} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {
    EditionConfig,
    EditionKind,
    EditionStatus,
    MintMark,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref,
    RefKind
} from "../../src/editions/PNDEditionsTypes.sol";

contract PNDEditionsTest is PNDEditionsBase {
    // ── factory ───────────────────────────────────────────────────────────────

    function test_factory_deploysOwnedUpgradeableEdition() public {
        PNDEditions p = _edition(_freeConfig());
        assertEq(p.owner(), artist);
        assertEq(p.name(), "Artist Edition");
        assertEq(p.symbol(), "AED");
        assertTrue(factory.isEdition(address(p)));
        assertEq(factory.totalEditions(), 1);
        assertTrue(p.isUpgradeable()); // always upgradeable until sealed
        assertFalse(p.isSealed());
        assertEq(p.surfaceShareBps(), 1000); // fixed 10%
    }

    function test_startTokenIdIsOne() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1, address(0), "");
        assertEq(p.ownerOf(1), collector);
        assertEq(p.totalSupply(), 1);
    }

    function test_configReadable() public {
        PNDEditions p = _edition(_pricedConfig(0.05 ether));
        (EditionConfig memory cfg, EditionStatus status, uint256 minted) = p.config();
        assertEq(cfg.price, 0.05 ether);
        assertEq(uint8(status), uint8(EditionStatus.Open));
        assertEq(minted, 0);
    }

    // ── mint: gas-only ──────────────────────────────────────────────────────────

    function test_mint_gasOnly_succeeds() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(3, address(0), "");
        assertEq(p.balanceOf(collector), 3);
        assertEq(p.ownerOf(3), collector);
    }

    function test_mint_gasOnly_rejectsValue() public {
        PNDEditions p = _edition(_freeConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 1 wei}(1, address(0), "");
    }

    function test_mint_zeroQuantityReverts() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(bytes("PND: zero qty"));
        vm.prank(collector);
        p.mint(0, address(0), "");
    }

    // ── mint: priced + fixed surface split ──────────────────────────────────────

    function test_mint_priced_requiresExactValue() public {
        PNDEditions p = _edition(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 0.2 ether}(1, address(0), "");
    }

    function test_mint_priced_fixedTenPercentSplit() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);
        vm.prank(collector);
        p.mint{value: 2 ether}(2, surface, ""); // 2 tokens * 1 ETH

        assertEq(surface.balance, 0.2 ether); // fixed 10% of 2 ETH
        assertEq(artist.balance, 1.8 ether); // remainder to artist payout (owner)
        assertEq(p.balanceOf(collector), 2);
    }

    function test_mint_priced_zeroSurfaceFoldsToArtist() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1, address(0), ""); // direct mint, no surface
        assertEq(artist.balance, 1 ether); // full price to artist
    }

    function test_mint_selfHostSurfaceKeepsEverything() public {
        // The "deploy your own site" case: the artist passes their OWN address
        // as the surface, so the 10% surface share comes back to them too.
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1, artist, ""); // surface == artist
        assertEq(artist.balance, 1 ether); // 0.1 surface + 0.9 payout = 100%
    }

    function test_mint_customPayout() public {
        address payout = makeAddr("payout");
        EditionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = payout;
        PNDEditions p = _edition(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1, address(0), "");
        assertEq(payout.balance, 1 ether);
        assertEq(artist.balance, 0);
    }

    function test_mint_revertingPayoutBricksMint() public {
        RevertOnReceive bad = new RevertOnReceive();
        EditionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(bad);
        PNDEditions p = _edition(cfg);
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: pay failed"));
        vm.prank(collector);
        p.mint{value: 1 ether}(1, address(0), "");
    }

    // ── caps + windows ──────────────────────────────────────────────────────────

    function test_mint_capEnforced() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        PNDEditions p = _edition(cfg);

        vm.prank(collector);
        p.mint(2, address(0), "");
        vm.expectRevert(bytes("PND: exceeds cap"));
        vm.prank(collector);
        p.mint(2, address(0), "");
        vm.prank(collector);
        p.mint(1, address(0), "");

        (, EditionStatus status, uint256 minted) = p.config();
        assertEq(minted, 3);
        assertEq(uint8(status), uint8(EditionStatus.Closed));
    }

    function test_mint_windowEnforced() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        cfg.mintEnd = uint64(block.timestamp + 200);
        PNDEditions p = _edition(cfg);

        vm.expectRevert(bytes("PND: not started"));
        vm.prank(collector);
        p.mint(1, address(0), "");

        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        p.mint(1, address(0), "");

        vm.warp(block.timestamp + 100); // past mintEnd
        vm.expectRevert(bytes("PND: ended"));
        vm.prank(collector);
        p.mint(1, address(0), "");
    }

    // ── Mint Marks ──────────────────────────────────────────────────────────────

    function test_mintMarks_perTokenAndBatch() public {
        PNDEditions p = _edition(_freeConfig());

        // batch A: x3 -> tokens 1,2,3 (surface set)
        vm.prank(collector);
        p.mint(3, surface, "");
        // batch B: x2 -> tokens 4,5 (no surface)
        vm.prank(stranger);
        p.mint(2, address(0), "");

        MintMark memory m1 = p.mintMarkOf(1);
        assertEq(m1.indexInEdition, 0);
        assertEq(m1.surface, surface);
        assertTrue(m1.isFirst);

        MintMark memory m3 = p.mintMarkOf(3);
        assertEq(m3.indexInEdition, 2);
        assertEq(m3.surface, surface);

        MintMark memory m4 = p.mintMarkOf(4);
        assertEq(m4.indexInEdition, 3);
        assertEq(m4.surface, address(0)); // second batch had no surface
        assertFalse(m4.isFirst);
    }

    function test_mintMarks_finalResolvesWhenClosed() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        PNDEditions p = _edition(cfg);
        vm.prank(collector);
        p.mint(5, address(0), "");
        assertTrue(p.mintMarkOf(5).isFinal);
        assertFalse(p.mintMarkOf(4).isFinal);
        assertTrue(p.mintMarkOf(1).isFirst);
    }

    function test_mintMarks_manyBatchesBinarySearch() public {
        PNDEditions p = _edition(_freeConfig());
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(collector);
            p.mint(1, surface, "");
        }
        for (uint256 t = 1; t <= 20; t++) {
            assertEq(p.mintMarkOf(t).indexInEdition, t - 1);
        }
    }

    function test_mintMarks_revertForUnminted() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(bytes("PND: not minted"));
        p.mintMarkOf(1);
    }

    // ── renderer ──────────────────────────────────────────────────────────────

    function test_tokenURI_defaultRendererReturnsDataUri() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1, address(0), "");
        assertTrue(_startsWith(p.tokenURI(1), "data:application/json;base64,"));
    }

    function test_tokenURI_customRendererOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1, address(0), "");
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        p.setRenderer(address(custom));
        assertEq(p.tokenURI(1), "custom://token");
        assertEq(p.renderer(), address(custom));
    }

    function test_tokenArtwork_perTokenOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(2, address(0), "");
        vm.prank(artist);
        p.setTokenArtwork(2, "ipfs://QmUnique");
        assertEq(p.tokenArtwork(2), "ipfs://QmUnique");
        assertEq(p.tokenArtwork(1), "");
    }

    function test_tokenURI_nonexistentReverts() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert();
        p.tokenURI(1);
    }

    // ── royalties ──────────────────────────────────────────────────────────────

    function test_royaltyInfo() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        PNDEditions p = _edition(cfg);
        vm.prank(collector);
        p.mint(1, address(0), "");
        (address receiver, uint256 amount) = p.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(p.supportsInterface(0x2a55205a));
    }

    function test_royaltyInfo_defaultsToOwner() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        PNDEditions p = _edition(cfg);
        vm.prank(collector);
        p.mint(1, address(0), "");
        (address receiver,) = p.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    // ── token path ──────────────────────────────────────────────────────────────

    function test_tokenPath_defaultAndOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(2, address(0), "");

        Ref memory ed = Ref(1, address(p), 0, RefKind.Edition);
        vm.prank(artist);
        p.setDefaultPath(PathType.Continuation, ed, bytes32(0));
        assertEq(uint8(p.pathOf(1).pathType), uint8(PathType.Continuation));
        assertEq(uint8(p.pathOf(2).pathType), uint8(PathType.Continuation));

        Ref memory tok = Ref(1, address(p), 7, RefKind.Token);
        vm.prank(artist);
        p.setPath(2, PathType.Migration, tok, bytes32(uint256(42)));
        assertEq(uint8(p.pathOf(2).pathType), uint8(PathType.Migration));
        assertEq(p.pathOf(2).data, bytes32(uint256(42)));
        assertEq(uint8(p.pathOf(1).pathType), uint8(PathType.Continuation));
    }

    function test_tokenPath_onlyOwner() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1, address(0), "");
        Ref memory ed = Ref(1, address(p), 0, RefKind.Edition);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", collector));
        vm.prank(collector);
        p.setPath(1, PathType.Burn, ed, bytes32(0));
    }

    // ── edition graph ──────────────────────────────────────────────────────────

    function test_editionGraph_appendEdges() public {
        PNDEditions p = _edition(_freeConfig());
        Ref memory parent = Ref(1, makeAddr("otherEdition"), 0, RefKind.Edition);
        vm.prank(artist);
        p.addEdge(EdgeType.PhaseOf, parent);
        Ref memory src = Ref(1, makeAddr("source"), 3, RefKind.Token);
        vm.prank(artist);
        p.addEdge(EdgeType.Continues, src);

        Edge[] memory e = p.edges();
        assertEq(e.length, 2);
        assertEq(uint8(e[0].edgeType), uint8(EdgeType.PhaseOf));
        assertEq(e[0].target.contractAddress, makeAddr("otherEdition"));
        assertEq(uint8(e[1].edgeType), uint8(EdgeType.Continues));
        assertEq(e[1].target.id, 3);
    }

    function test_editionGraph_onlyOwner() public {
        PNDEditions p = _edition(_freeConfig());
        Ref memory ed = Ref(1, address(p), 0, RefKind.Edition);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.addEdge(EdgeType.BelongsTo, ed);
    }

    // ── fuzz: the money path ────────────────────────────────────────────────────

    function testFuzz_splitIsExactAndConserved(uint96 priceRaw, uint8 qtyRaw) public {
        uint256 price = uint256(priceRaw);
        uint256 qty = bound(qtyRaw, 1, 50);

        address payout = makeAddr("fuzzPayout");
        address surf = makeAddr("fuzzSurface");
        EditionConfig memory cfg = _pricedConfig(price);
        cfg.payoutAddress = payout;
        PNDEditions p = _edition(cfg);

        uint256 total = price * qty;
        address buyer = makeAddr("fuzzBuyer");
        vm.deal(buyer, total);

        uint256 sBefore = surf.balance;
        uint256 pBefore = payout.balance;
        vm.prank(buyer);
        p.mint{value: total}(qty, surf, "");

        uint256 expectedSurface = (total * 1000) / 10_000; // fixed 10%
        assertEq(surf.balance - sBefore, expectedSurface, "surface cut");
        assertEq(payout.balance - pBefore, total - expectedSurface, "artist cut");
        assertEq(address(p).balance, 0, "no residue");
        assertEq(p.balanceOf(buyer), qty);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }
}
