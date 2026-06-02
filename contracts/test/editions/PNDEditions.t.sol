// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {MockRenderer, RevertOnReceive} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {
    ReleaseConfig,
    ReleaseKind,
    ReleaseStatus,
    ProjectMode,
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

    function test_factory_deploysOwnedProject() public {
        PNDEditions p = _immutableProject();
        assertEq(p.owner(), artist);
        assertEq(p.name(), "Artist Project");
        assertEq(p.symbol(), "APJ");
        assertTrue(factory.isProject(address(p)));
        assertEq(factory.totalProjects(), 1);
        assertFalse(p.isUpgradeable()); // immutable clone
        assertFalse(p.isSealed());
    }

    function test_factory_startTokenIdIsOne() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
        assertEq(p.ownerOf(1), collector);
        assertEq(p.totalSupply(), 1);
    }

    // ── releases ──────────────────────────────────────────────────────────────

    function test_createRelease_onlyOwner() public {
        PNDEditions p = _immutableProject();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.createRelease(_freeReleaseConfig());
    }

    function test_createRelease_sequentialIds() public {
        PNDEditions p = _immutableProject();
        assertEq(_createRelease(p, _freeReleaseConfig()), 0);
        assertEq(_createRelease(p, _freeReleaseConfig()), 1);
        assertEq(_createRelease(p, _freeReleaseConfig()), 2);
        assertEq(p.totalReleases(), 3);
    }

    function test_createRelease_rejectsBadWindowAndBps() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 50; // end before start
        vm.expectRevert(bytes("PND: bad window"));
        vm.prank(artist);
        p.createRelease(cfg);

        cfg = _freeReleaseConfig();
        cfg.surfaceShareBps = 10_001;
        vm.expectRevert(bytes("PND: surface bps"));
        vm.prank(artist);
        p.createRelease(cfg);
    }

    // ── mint: gas-only ──────────────────────────────────────────────────────────

    function test_mint_gasOnly_succeedsWithZeroValue() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 3, address(0), "");
        assertEq(p.balanceOf(collector), 3);
        assertEq(p.ownerOf(1), collector);
        assertEq(p.ownerOf(3), collector);
    }

    function test_mint_gasOnly_rejectsValue() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 1 wei}(id, 1, address(0), "");
    }

    function test_mint_zeroQuantityReverts() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.expectRevert(bytes("PND: zero qty"));
        vm.prank(collector);
        p.mint(id, 0, address(0), "");
    }

    function test_mint_unknownReleaseReverts() public {
        PNDEditions p = _immutableProject();
        vm.expectRevert(bytes("PND: no release"));
        vm.prank(collector);
        p.mint(0, 1, address(0), "");
    }

    // ── mint: priced + surface split ──────────────────────────────────────────

    function test_mint_priced_requiresExactValue() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _pricedReleaseConfig(0.1 ether, 0));
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 0.2 ether}(id, 1, address(0), "");
    }

    function test_mint_priced_splitsOutOfPrice() public {
        PNDEditions p = _immutableProject();
        // 10% surface share
        uint256 id = _createRelease(p, _pricedReleaseConfig(1 ether, 1000));
        vm.deal(collector, 2 ether);

        vm.prank(collector);
        p.mint{value: 2 ether}(id, 2, surface, ""); // 2 tokens * 1 ETH

        assertEq(surface.balance, 0.2 ether); // 10% of 2 ETH
        assertEq(artist.balance, 1.8 ether); // remainder to artist payout (owner)
        assertEq(p.balanceOf(collector), 2);
    }

    function test_mint_priced_zeroSurfaceFoldsToArtist() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _pricedReleaseConfig(1 ether, 1000));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(id, 1, address(0), ""); // surface == 0
        assertEq(artist.balance, 1 ether); // full price to artist
    }

    function test_mint_priced_customPayout() public {
        PNDEditions p = _immutableProject();
        address payout = makeAddr("payout");
        ReleaseConfig memory cfg = _pricedReleaseConfig(1 ether, 0);
        cfg.payoutAddress = payout;
        uint256 id = _createRelease(p, cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(id, 1, address(0), "");
        assertEq(payout.balance, 1 ether);
        assertEq(artist.balance, 0);
    }

    function test_mint_revertingPayoutBricksMint() public {
        PNDEditions p = _immutableProject();
        RevertOnReceive bad = new RevertOnReceive();
        ReleaseConfig memory cfg = _pricedReleaseConfig(1 ether, 0);
        cfg.payoutAddress = address(bad);
        uint256 id = _createRelease(p, cfg);
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: pay failed"));
        vm.prank(collector);
        p.mint{value: 1 ether}(id, 1, address(0), "");
    }

    // ── caps + windows ──────────────────────────────────────────────────────────

    function test_mint_capEnforced() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.supplyCap = 3;
        uint256 id = _createRelease(p, cfg);

        vm.prank(collector);
        p.mint(id, 2, address(0), "");
        // exceeding cap reverts
        vm.expectRevert(bytes("PND: exceeds cap"));
        vm.prank(collector);
        p.mint(id, 2, address(0), "");
        // exact remainder ok
        vm.prank(collector);
        p.mint(id, 1, address(0), "");

        (, ReleaseStatus status, uint256 minted) = p.release(id);
        assertEq(minted, 3);
        assertEq(uint8(status), uint8(ReleaseStatus.Closed));
    }

    function test_mint_windowEnforced() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        cfg.mintEnd = uint64(block.timestamp + 200);
        uint256 id = _createRelease(p, cfg);

        // before start
        vm.expectRevert(bytes("PND: not started"));
        vm.prank(collector);
        p.mint(id, 1, address(0), "");

        // within window
        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        p.mint(id, 1, address(0), "");

        // after end
        vm.warp(block.timestamp + 100); // now past mintEnd
        vm.expectRevert(bytes("PND: ended"));
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
    }

    // ── Mint Marks ──────────────────────────────────────────────────────────────

    function test_mintMarks_interleavedReleasesResolveCorrectly() public {
        PNDEditions p = _immutableProject();
        uint256 r0 = _createRelease(p, _freeReleaseConfig());
        uint256 r1 = _createRelease(p, _freeReleaseConfig());

        // batch A: r0 x3 -> tokens 1,2,3
        vm.prank(collector);
        p.mint(r0, 3, surface, "");
        // batch B: r1 x2 -> tokens 4,5
        vm.prank(collector);
        p.mint(r1, 2, address(0), "");
        // batch C: r0 x4 -> tokens 6,7,8,9
        vm.prank(stranger);
        p.mint(r0, 4, surface, "");

        // token 2: release 0, index 1, surface set
        MintMark memory m2 = p.mintMarkOf(2);
        assertEq(m2.releaseId, 0);
        assertEq(m2.indexInRelease, 1);
        assertEq(m2.surface, surface);
        assertFalse(m2.isFirst);

        // token 1: first of release 0
        assertTrue(p.mintMarkOf(1).isFirst);

        // token 4: first of release 1, no surface
        MintMark memory m4 = p.mintMarkOf(4);
        assertEq(m4.releaseId, 1);
        assertEq(m4.indexInRelease, 0);
        assertEq(m4.surface, address(0));
        assertTrue(m4.isFirst);

        // token 7: release 0, startIndex 3 + (7-6) = 4
        MintMark memory m7 = p.mintMarkOf(7);
        assertEq(m7.releaseId, 0);
        assertEq(m7.indexInRelease, 4);
        assertEq(m7.surface, surface);

        // token 5: release 1, index 1
        MintMark memory m5 = p.mintMarkOf(5);
        assertEq(m5.releaseId, 1);
        assertEq(m5.indexInRelease, 1);

        assertEq(p.releaseOf(9), 0);
        assertEq(p.releaseOf(5), 1);
    }

    function test_mintMarks_finalResolvesWhenClosed() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.supplyCap = 5;
        uint256 id = _createRelease(p, cfg);

        vm.prank(collector);
        p.mint(id, 5, address(0), "");

        // not closed-> isFinal false? cap reached so Closed -> token 5 isFinal
        assertTrue(p.mintMarkOf(5).isFinal);
        assertFalse(p.mintMarkOf(4).isFinal);
        assertTrue(p.mintMarkOf(1).isFirst);
    }

    function test_mintMarks_manyBatchesBinarySearch() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        // 20 single mints -> 20 batches, tokens 1..20
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(collector);
            p.mint(id, 1, surface, "");
        }
        for (uint256 t = 1; t <= 20; t++) {
            MintMark memory m = p.mintMarkOf(t);
            assertEq(m.releaseId, 0);
            assertEq(m.indexInRelease, t - 1);
        }
    }

    function test_mintMarks_revertForUnminted() public {
        PNDEditions p = _immutableProject();
        _createRelease(p, _freeReleaseConfig());
        vm.expectRevert(bytes("PND: not minted"));
        p.mintMarkOf(1);
    }

    // ── renderer ──────────────────────────────────────────────────────────────

    function test_tokenURI_defaultRendererReturnsDataUri() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
        string memory uri = p.tokenURI(1);
        assertTrue(_startsWith(uri, "data:application/json;base64,"));
    }

    function test_tokenURI_customRendererOverride() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 1, address(0), "");

        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        p.setReleaseRenderer(id, address(custom));
        assertEq(p.tokenURI(1), "custom://token");
        assertEq(p.rendererOf(id), address(custom));
    }

    function test_tokenURI_perTokenArtworkStored() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 2, address(0), "");

        vm.prank(artist);
        p.setTokenArtwork(2, "ipfs://QmUnique");
        assertEq(p.tokenArtwork(2), "ipfs://QmUnique");
        assertEq(p.tokenArtwork(1), ""); // falls back to release art
    }

    function test_tokenURI_nonexistentReverts() public {
        PNDEditions p = _immutableProject();
        _createRelease(p, _freeReleaseConfig());
        vm.expectRevert(); // URIQueryForNonexistentToken
        p.tokenURI(1);
    }

    // ── royalties ──────────────────────────────────────────────────────────────

    function test_royaltyInfo_perRelease() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.royaltyBps = 500; // 5%
        cfg.royaltyReceiver = makeAddr("royalty");
        uint256 id = _createRelease(p, cfg);
        vm.prank(collector);
        p.mint(id, 1, address(0), "");

        (address receiver, uint256 amount) = p.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(p.supportsInterface(0x2a55205a)); // IERC2981
    }

    function test_royaltyInfo_defaultsToOwner() public {
        PNDEditions p = _immutableProject();
        ReleaseConfig memory cfg = _freeReleaseConfig();
        cfg.royaltyBps = 250;
        uint256 id = _createRelease(p, cfg);
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
        (address receiver,) = p.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // owner
    }

    // ── token path ──────────────────────────────────────────────────────────────

    function test_tokenPath_releaseDefaultAndOverride() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 2, address(0), "");

        Ref memory rel = Ref(1, address(p), 99, RefKind.Release);
        vm.prank(artist);
        p.setReleaseDefaultPath(id, PathType.Continuation, rel, bytes32(0));

        // both tokens inherit the release default
        assertEq(uint8(p.pathOf(1).pathType), uint8(PathType.Continuation));
        assertEq(p.pathOf(2).target.id, 99);

        // per-token override on token 2
        Ref memory tok = Ref(1, address(p), 7, RefKind.Token);
        vm.prank(artist);
        p.setPath(2, PathType.Migration, tok, bytes32(uint256(42)));
        assertEq(uint8(p.pathOf(2).pathType), uint8(PathType.Migration));
        assertEq(p.pathOf(2).data, bytes32(uint256(42)));
        // token 1 still on the default
        assertEq(uint8(p.pathOf(1).pathType), uint8(PathType.Continuation));
    }

    function test_tokenPath_onlyOwner() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
        Ref memory rel = Ref(1, address(p), 0, RefKind.Release);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", collector));
        vm.prank(collector);
        p.setPath(1, PathType.Burn, rel, bytes32(0));
    }

    // ── release graph ──────────────────────────────────────────────────────────

    function test_releaseGraph_appendEdges() public {
        PNDEditions p = _immutableProject();
        uint256 r0 = _createRelease(p, _freeReleaseConfig());
        uint256 r1 = _createRelease(p, _freeReleaseConfig());

        Ref memory parent = Ref(1, address(p), r0, RefKind.Release);
        vm.prank(artist);
        p.addEdge(r1, EdgeType.PhaseOf, parent);
        Ref memory ext = Ref(1, makeAddr("other"), 5, RefKind.Release);
        vm.prank(artist);
        p.addEdge(r1, EdgeType.Continues, ext);

        Edge[] memory edges = p.edgesOf(r1);
        assertEq(edges.length, 2);
        assertEq(uint8(edges[0].edgeType), uint8(EdgeType.PhaseOf));
        assertEq(edges[0].target.id, r0);
        assertEq(uint8(edges[1].edgeType), uint8(EdgeType.Continues));
        assertEq(edges[1].target.contractAddress, makeAddr("other"));
    }

    function test_releaseGraph_onlyOwner() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        Ref memory rel = Ref(1, address(p), id, RefKind.Release);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.addEdge(id, EdgeType.BelongsTo, rel);
    }

    // ── fuzz: the money path ────────────────────────────────────────────────────

    function testFuzz_splitIsExactAndConserved(uint96 priceRaw, uint16 bpsRaw, uint8 qtyRaw)
        public
    {
        uint256 price = uint256(priceRaw);
        uint16 bps = uint16(bound(bpsRaw, 0, 10_000));
        uint256 qty = bound(qtyRaw, 1, 50);

        PNDEditions p = _immutableProject();
        address payout = makeAddr("fuzzPayout");
        address surf = makeAddr("fuzzSurface");
        ReleaseConfig memory cfg = _pricedReleaseConfig(price, bps);
        cfg.payoutAddress = payout;
        uint256 id = _createRelease(p, cfg);

        uint256 total = price * qty;
        address buyer = makeAddr("fuzzBuyer");
        vm.deal(buyer, total);

        uint256 sBefore = surf.balance;
        uint256 pBefore = payout.balance;
        vm.prank(buyer);
        p.mint{value: total}(id, qty, surf, "");

        uint256 expectedSurface = bps == 0 ? 0 : (total * bps) / 10_000;
        assertEq(surf.balance - sBefore, expectedSurface, "surface cut");
        assertEq(payout.balance - pBefore, total - expectedSurface, "artist cut");
        // conservation: nothing left in the contract, nothing minted as fee
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
