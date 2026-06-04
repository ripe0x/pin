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
        assertFalse(p.isMetadataFrozen());
        assertEq(p.surfaceShareBps(), 1000); // fixed 10%
    }

    function test_startTokenIdIsOne() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
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
        p.mint(3);
        assertEq(p.balanceOf(collector), 3);
        assertEq(p.ownerOf(3), collector);
    }

    function test_mint_gasOnly_rejectsValue() public {
        PNDEditions p = _edition(_freeConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 1 wei}(1);
    }

    function test_mint_zeroQuantityReverts() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(bytes("PND: zero qty"));
        vm.prank(collector);
        p.mint(0);
    }

    // ── mint + pull-payment split ─────────────────────────────────────────────

    function test_mint_priced_requiresExactValue() public {
        PNDEditions p = _edition(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(bytes("PND: wrong payment"));
        vm.prank(collector);
        p.mint{value: 0.2 ether}(1);
    }

    function test_simpleMint_foldsFullPriceToArtist() public {
        // mint(quantity) defaults surface to 0 -> artist gets 100%.
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);
        assertEq(p.pendingWithdrawal(artist), 1 ether); // full price accrued to artist
        assertEq(address(p).balance, 1 ether); // held until withdraw
    }

    function test_mintWithRewards_fixedTenPercentSplit() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);
        vm.prank(collector);
        p.mintWithRewards{value: 2 ether}(2, surface, ""); // 2 tokens * 1 ETH

        assertEq(p.pendingWithdrawal(surface), 0.2 ether); // fixed 10% of 2 ETH
        assertEq(p.pendingWithdrawal(artist), 1.8 ether); // remainder to artist payout
        assertEq(p.balanceOf(collector), 2);
    }

    function test_mintWithRewards_zeroSurfaceFoldsToArtist() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mintWithRewards{value: 1 ether}(1, address(0), "");
        assertEq(p.pendingWithdrawal(artist), 1 ether);
    }

    function test_selfHostSurfaceKeepsEverything() public {
        // The "deploy your own site" case: the artist passes their OWN address
        // as the surface, so the 10% comes back to them too (100%).
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mintWithRewards{value: 1 ether}(1, artist, "");
        assertEq(p.pendingWithdrawal(artist), 1 ether); // 0.1 surface + 0.9 payout
    }

    function test_mint_customPayout() public {
        address payout = makeAddr("payout");
        EditionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = payout;
        PNDEditions p = _edition(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);
        assertEq(p.pendingWithdrawal(payout), 1 ether);
        assertEq(p.pendingWithdrawal(artist), 0);
    }

    // ── pull payments: withdraw + setPayoutAddress ────────────────────────────

    function test_withdraw_sendsToOwedAccount() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);

        uint256 before = artist.balance;
        p.withdraw(artist); // permissionless trigger; funds go to the owed address
        assertEq(artist.balance - before, 1 ether);
        assertEq(p.pendingWithdrawal(artist), 0);
    }

    function test_withdraw_nothingReverts() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(bytes("PND: nothing to withdraw"));
        p.withdraw(stranger);
    }

    function test_revertingPayoutDoesNotBrickMint() public {
        // A reverting payout no longer bricks minting (pull payments). It only
        // fails that recipient's own withdraw.
        RevertOnReceive bad = new RevertOnReceive();
        EditionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(bad);
        PNDEditions p = _edition(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1); // succeeds
        assertEq(p.balanceOf(collector), 1);
        assertEq(p.pendingWithdrawal(address(bad)), 1 ether);

        vm.expectRevert(bytes("PND: withdraw failed"));
        p.withdraw(address(bad));
    }

    function test_setPayoutAddress_routesFutureAccrual() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);

        vm.prank(collector);
        p.mint{value: 1 ether}(1); // accrues to owner (default payout)
        assertEq(p.pendingWithdrawal(artist), 1 ether);

        address newPayout = makeAddr("newPayout");
        vm.prank(artist);
        p.setPayoutAddress(newPayout);

        vm.prank(collector);
        p.mint{value: 1 ether}(1); // accrues to the new payout
        assertEq(p.pendingWithdrawal(newPayout), 1 ether);
        assertEq(p.pendingWithdrawal(artist), 1 ether); // earlier accrual untouched
    }

    function test_setPayoutAddress_onlyOwner() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.setPayoutAddress(stranger);
    }

    // ── caps + windows ──────────────────────────────────────────────────────────

    function test_mint_capEnforced() public {
        EditionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        PNDEditions p = _edition(cfg);

        vm.prank(collector);
        p.mint(2);
        vm.expectRevert(bytes("PND: exceeds cap"));
        vm.prank(collector);
        p.mint(2);
        vm.prank(collector);
        p.mint(1);

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
        p.mint(1);

        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        p.mint(1);

        vm.warp(block.timestamp + 100); // past mintEnd
        vm.expectRevert(bytes("PND: ended"));
        vm.prank(collector);
        p.mint(1);
    }

    // ── Mint Marks ──────────────────────────────────────────────────────────────

    function test_mintMarks_perTokenAndBatch() public {
        PNDEditions p = _edition(_freeConfig());

        // batch A: x3 -> tokens 1,2,3 (surface set)
        vm.prank(collector);
        p.mintWithRewards(3, surface, "");
        // batch B: x2 -> tokens 4,5 (no surface)
        vm.prank(stranger);
        p.mint(2);

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
        p.mint(5);
        assertTrue(p.mintMarkOf(5).isFinal);
        assertFalse(p.mintMarkOf(4).isFinal);
        assertTrue(p.mintMarkOf(1).isFirst);
    }

    function test_mintMarks_manyBatchesBinarySearch() public {
        PNDEditions p = _edition(_freeConfig());
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(collector);
            p.mintWithRewards(1, surface, "");
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

    // ── renderer + metadata freeze ────────────────────────────────────────────

    function test_tokenURI_defaultRendererReturnsDataUri() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
        assertTrue(_startsWith(p.tokenURI(1), "data:application/json;base64,"));
    }

    function test_tokenURI_customRendererOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        p.setRenderer(address(custom));
        assertEq(p.tokenURI(1), "custom://token");
        assertEq(p.renderer(), address(custom));
    }

    function test_tokenArtwork_perTokenOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(2);
        vm.prank(artist);
        p.setTokenArtwork(2, "ipfs://QmUnique");
        assertEq(p.tokenArtwork(2), "ipfs://QmUnique");
        assertEq(p.tokenArtwork(1), "");
    }

    function test_freezeMetadata_blocksRendererAndArtwork() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);

        vm.prank(artist);
        p.freezeMetadata();
        assertTrue(p.isMetadataFrozen());

        MockRenderer custom = new MockRenderer();
        vm.expectRevert(bytes("PND: metadata frozen"));
        vm.prank(artist);
        p.setRenderer(address(custom));

        vm.expectRevert(bytes("PND: metadata frozen"));
        vm.prank(artist);
        p.setTokenArtwork(1, "ipfs://QmNope");

        vm.expectRevert(bytes("PND: already frozen"));
        vm.prank(artist);
        p.freezeMetadata();
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
        p.mint(1);
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
        p.mint(1);
        (address receiver,) = p.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    // ── token path ──────────────────────────────────────────────────────────────

    function test_tokenPath_defaultAndOverride() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(2);

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
        p.mint(1);
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
        PNDEditions p = _edition(cfg); // fresh edition each run; no cross-run accrual

        uint256 total = price * qty;
        address buyer = makeAddr("fuzzBuyer");
        vm.deal(buyer, total);
        vm.prank(buyer);
        p.mintWithRewards{value: total}(qty, surf, "");

        uint256 expectedSurface = (total * 1000) / 10_000; // fixed 10%
        assertEq(p.pendingWithdrawal(surf), expectedSurface, "surface cut");
        assertEq(p.pendingWithdrawal(payout), total - expectedSurface, "artist cut");
        assertEq(address(p).balance, total, "all funds held for withdrawal");
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
