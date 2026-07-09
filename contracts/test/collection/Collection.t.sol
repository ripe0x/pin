// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {
    MockRenderer,
    RevertingPayee
} from "./mocks/CollectionMocks.sol";

import {SovereignCollection} from "../../src/collection/SovereignCollection.sol";
import {ISovereignCollection} from "../../src/collection/interfaces/ISovereignCollection.sol";
import {
    CollectionConfig,
    CollectionStatus,
    CollectionKind,
    IdMode,
    InitParams,
    MintMark,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref,
    RefKind
} from "../../src/collection/CollectionTypes.sol";

contract CollectionTest is CollectionBase {
    // ── init validation ──────────────────────────────────────────────────────

    function test_init_rejectsZeroOwner() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.owner = address(0);
        SovereignCollection clone = _freshClone();
        vm.expectRevert(ISovereignCollection.OwnerRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsZeroDefaultRenderer() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.defaultRenderer = address(0);
        SovereignCollection clone = _freshClone();
        vm.expectRevert(ISovereignCollection.RendererRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsRoyaltyTooHigh() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5001; // > 50% cap
        InitParams memory p = _rawInitParams(cfg);
        SovereignCollection clone = _freshClone();
        vm.expectRevert(ISovereignCollection.RoyaltyTooHigh.selector);
        clone.initialize(p);
    }

    function test_init_allowsRoyaltyAtCap() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5000; // exactly 50%, allowed
        SovereignCollection c = _collection(cfg);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // defaults to owner when royaltyReceiver unset
        assertEq(amount, 0.5 ether);
    }

    function test_init_rejectsBadWindow_endBeforeStart() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 200;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        SovereignCollection clone = _freshClone();
        vm.expectRevert(ISovereignCollection.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_rejectsBadWindow_endEqualsStart() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        SovereignCollection clone = _freshClone();
        vm.expectRevert(ISovereignCollection.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_allowsOpenEndedWindow() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 0; // open-ended is fine regardless of start
        SovereignCollection c = _collection(cfg);
        (CollectionConfig memory readCfg,,) = c.config();
        assertEq(readCfg.mintStart, 100);
        assertEq(readCfg.mintEnd, 0);
    }

    function test_init_rejectsZeroInitialMinter() public {
        CollectionConfig memory cfg = _pooledConfig();
        address[] memory minters = new address[](1);
        minters[0] = address(0);
        vm.expectRevert(ISovereignCollection.ZeroMinter.selector);
        _collectionWithMinters(cfg, minters);
    }

    function test_init_grantsInitialMinters() public {
        CollectionConfig memory cfg = _pooledConfig();
        address m = makeAddr("initialMinter");
        address[] memory minters = new address[](1);
        minters[0] = m;
        SovereignCollection c = _collectionWithMinters(cfg, minters);
        assertTrue(c.isMinter(m));
    }

    // ── config views ─────────────────────────────────────────────────────────

    function test_configReadable() public {
        SovereignCollection c = _collection(_pricedConfig(0.05 ether));
        (CollectionConfig memory cfg, CollectionStatus status, uint256 minted) = c.config();
        assertEq(cfg.price, 0.05 ether);
        assertEq(uint8(status), uint8(CollectionStatus.Open));
        assertEq(minted, 0);
    }

    function test_factory_deploysOwnedClone() public {
        SovereignCollection c = _collection(_freeConfig());
        assertEq(c.owner(), artist);
        assertEq(c.name(), "Artist Collection");
        assertEq(c.symbol(), "ACOL");
        assertTrue(factory.isCollection(address(c)));
        assertEq(factory.totalCollections(), 1);
        assertEq(c.referralShareBps(), 1000);
        assertFalse(c.isMetadataFrozen());
        assertFalse(c.isWorkLocked());
        assertFalse(c.isPermanent());
    }

    function test_startTokenIdIsOne() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.ownerOf(1), collector);
        assertEq(c.totalSupply(), 1);
    }

    function test_idMode_reads() public {
        SovereignCollection seq = _collection(_freeConfig());
        assertEq(uint8(seq.idMode()), uint8(IdMode.Sequential));
        SovereignCollection pooled = _collection(_pooledConfig());
        assertEq(uint8(pooled.idMode()), uint8(IdMode.Pooled));
    }

    // ── paid mint happy paths ────────────────────────────────────────────────

    function test_mint_gasOnly_succeeds() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3);
        assertEq(c.balanceOf(collector), 3);
        assertEq(c.ownerOf(3), collector);
        assertEq(c.totalSupply(), 3);
    }

    function test_mint_zeroQuantityReverts() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.ZeroQuantity.selector);
        vm.prank(collector);
        c.mint(0);
    }

    function test_mint_gasOnly_rejectsValue() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(ISovereignCollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 1 wei}(1);
    }

    function test_mint_pooledRejectsPaidPath() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.expectRevert(ISovereignCollection.PooledSellsViaMinter.selector);
        vm.prank(collector);
        c.mint(1);
    }

    // ── exact-payment enforcement ────────────────────────────────────────────

    function test_mint_priced_requiresExactValue_under() public {
        SovereignCollection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(ISovereignCollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 0.05 ether}(1);
    }

    function test_mint_priced_requiresExactValue_over() public {
        SovereignCollection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(ISovereignCollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 0.2 ether}(1);
    }

    function test_mint_priced_exactValueSucceeds() public {
        SovereignCollection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 0.3 ether);
        vm.prank(collector);
        c.mint{value: 0.3 ether}(3);
        assertEq(c.balanceOf(collector), 3);
    }

    // ── referral share math ───────────────────────────────────────────────────

    function test_simpleMint_foldsFullPriceToArtist() public {
        // mint(quantity) defaults referrer to 0 -> artist gets 100%.
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(artist), 1 ether);
        assertEq(address(c).balance, 1 ether); // held until withdraw
    }

    function test_mintWithReferral_fixedTenPercentSplit() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 2 ether}(2, referrer, ""); // 2 tokens * 1 ETH

        assertEq(c.pendingWithdrawal(referrer), 0.2 ether); // fixed 10% of 2 ETH
        assertEq(c.pendingWithdrawal(artist), 1.8 ether); // remainder to artist payout
        assertEq(c.balanceOf(collector), 2);
    }

    function test_mintWithReferral_zeroReferrerFoldsToArtist() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, address(0), "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_selfHostReferrerKeepsEverything() public {
        // Artist passes their OWN address as referrer: the 10% comes back to
        // them too (100% total).
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, artist, "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_referralShare_exactBpsMath() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 10 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 10 ether}(10, referrer, "");
        assertEq(c.pendingWithdrawal(referrer), 1 ether); // 10% of 10 ETH
        assertEq(c.pendingWithdrawal(artist), 9 ether);
    }

    // ── payout address routing ───────────────────────────────────────────────

    function test_mint_customPayout() public {
        address payout = makeAddr("payout");
        CollectionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = payout;
        SovereignCollection c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(payout), 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_setPayoutAddress_routesFutureAccrualsOnly() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);

        vm.prank(collector);
        c.mint{value: 1 ether}(1); // accrues to owner (default payout)
        assertEq(c.pendingWithdrawal(artist), 1 ether);

        address newPayout = makeAddr("newPayout");
        vm.prank(artist);
        c.setPayoutAddress(newPayout);

        vm.prank(collector);
        c.mint{value: 1 ether}(1); // accrues to the new payout
        assertEq(c.pendingWithdrawal(newPayout), 1 ether);
        assertEq(c.pendingWithdrawal(artist), 1 ether); // earlier accrual untouched
    }

    function test_setPayoutAddress_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPayoutAddress(stranger);
    }

    // ── pull withdrawals ─────────────────────────────────────────────────────

    function test_withdraw_sendsToOwedAccount() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        uint256 before = artist.balance;
        c.withdraw(artist); // permissionless trigger; funds go to the owed address
        assertEq(artist.balance - before, 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_withdraw_nothingReverts() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NothingToWithdraw.selector);
        c.withdraw(stranger);
    }

    function test_withdraw_rejectsZeroAccount() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.ZeroAccount.selector);
        c.withdraw(address(0));
    }

    function test_revertingPayeeCannotBrickMint() public {
        // A reverting payee no longer bricks minting (pull payments). It only
        // fails that recipient's own withdraw.
        RevertingPayee bad = new RevertingPayee();
        CollectionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(bad);
        SovereignCollection c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1); // succeeds despite the payee being unable to receive ETH
        assertEq(c.balanceOf(collector), 1);
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);

        vm.expectRevert(ISovereignCollection.WithdrawFailed.selector);
        c.withdraw(address(bad));

        // Funds remain intact and claimable if the payee later routes payout
        // elsewhere (a stuck payee does not lose its own accrual, it just
        // cannot self-serve the pull; the balance stays owed to it forever).
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);
    }

    function test_pendingWithdrawal_accumulatesAcrossMints() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 3 ether);
        vm.startPrank(collector);
        c.mint{value: 1 ether}(1);
        c.mint{value: 1 ether}(1);
        c.mint{value: 1 ether}(1);
        vm.stopPrank();
        assertEq(c.pendingWithdrawal(artist), 3 ether);
    }

    // ── rescueStrayETH ───────────────────────────────────────────────────────

    function test_rescueStrayETH_onlyAboveOwed() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1); // 1 ETH owed to artist, balance 1 ETH

        // Simulate 0.5 ETH force-fed (selfdestruct / coinbase): balance now 1.5.
        vm.deal(address(c), 1.5 ether);

        address dest = makeAddr("rescueDest");
        vm.prank(artist);
        c.rescueStrayETH(dest);
        assertEq(dest.balance, 0.5 ether); // only the stray surplus
        assertEq(address(c).balance, 1 ether); // owed balance untouched

        c.withdraw(artist);
        assertEq(artist.balance, 1 ether);

        vm.expectRevert(ISovereignCollection.NoStrayETH.selector);
        vm.prank(artist);
        c.rescueStrayETH(dest);
    }

    function test_rescueStrayETH_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.rescueStrayETH(stranger);
    }

    function test_rescueStrayETH_rejectsZeroAccount() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISovereignCollection.ZeroAccount.selector);
        vm.prank(artist);
        c.rescueStrayETH(address(0));
    }

    // ── closing flag ─────────────────────────────────────────────────────────

    function test_setClosing_flagsStatus() public {
        SovereignCollection c = _collection(_freeConfig());
        (, CollectionStatus statusBefore,) = c.config();
        assertEq(uint8(statusBefore), uint8(CollectionStatus.Open));

        vm.prank(artist);
        c.setClosing(true);
        (, CollectionStatus statusAfter,) = c.config();
        assertEq(uint8(statusAfter), uint8(CollectionStatus.Closing));

        vm.prank(collector);
        c.mint(1);
        assertEq(uint8(c.mintMarkOf(1).statusAtMint), uint8(CollectionStatus.Closing));
    }

    function test_setClosing_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setClosing(true);
    }

    // ── supply cap (sequential) ──────────────────────────────────────────────

    function test_mint_capEnforced_sequential() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        SovereignCollection c = _collection(cfg);

        vm.prank(collector);
        c.mint(2);
        vm.expectRevert(ISovereignCollection.ExceedsCap.selector);
        vm.prank(collector);
        c.mint(2);
        vm.prank(collector);
        c.mint(1);

        (, CollectionStatus status, uint256 minted) = c.config();
        assertEq(minted, 3);
        assertEq(uint8(status), uint8(CollectionStatus.Closed));
    }

    // ── mint window ──────────────────────────────────────────────────────────

    function test_mint_windowEnforced() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        cfg.mintEnd = uint64(block.timestamp + 200);
        SovereignCollection c = _collection(cfg);

        vm.expectRevert(ISovereignCollection.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 100); // past mintEnd
        vm.expectRevert(ISovereignCollection.MintEnded.selector);
        vm.prank(collector);
        c.mint(1);
    }

    // ── graph + token path ───────────────────────────────────────────────────

    function test_graph_appendEdges() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory parent = Ref(1, makeAddr("otherCollection"), 0, RefKind.Collection);
        vm.prank(artist);
        c.addEdge(EdgeType.PhaseOf, parent);
        Ref memory src = Ref(1, makeAddr("source"), 3, RefKind.Token);
        vm.prank(artist);
        c.addEdge(EdgeType.Continues, src);

        Edge[] memory e = c.edges();
        assertEq(e.length, 2);
        assertEq(uint8(e[0].edgeType), uint8(EdgeType.PhaseOf));
        assertEq(e[0].target.contractAddress, makeAddr("otherCollection"));
        assertEq(uint8(e[1].edgeType), uint8(EdgeType.Continues));
        assertEq(e[1].target.id, 3);
    }

    function test_graph_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory ref = Ref(1, address(c), 0, RefKind.Collection);
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.addEdge(EdgeType.BelongsTo, ref);
    }

    function test_graph_acknowledgeEdge_isToggleableAndIdempotent() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory src = Ref(1, makeAddr("source"), 0, RefKind.Collection);
        assertFalse(c.isEdgeAcknowledged(EdgeType.StudyOf, src));

        vm.prank(artist);
        c.acknowledgeEdge(EdgeType.StudyOf, src, true);
        assertTrue(c.isEdgeAcknowledged(EdgeType.StudyOf, src));

        // idempotent: acking again is a no-op success
        vm.prank(artist);
        c.acknowledgeEdge(EdgeType.StudyOf, src, true);
        assertTrue(c.isEdgeAcknowledged(EdgeType.StudyOf, src));

        vm.prank(artist);
        c.acknowledgeEdge(EdgeType.StudyOf, src, false);
        assertFalse(c.isEdgeAcknowledged(EdgeType.StudyOf, src));
    }

    function test_graph_acknowledgeEdge_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory src = Ref(1, makeAddr("source"), 0, RefKind.Collection);
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.acknowledgeEdge(EdgeType.StudyOf, src, true);
    }

    function test_tokenPath_defaultAndOverride() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(2);

        Ref memory col = Ref(1, address(c), 0, RefKind.Collection);
        vm.prank(artist);
        c.setDefaultPath(PathType.Continuation, col, bytes32(0));
        assertEq(uint8(c.pathOf(1).pathType), uint8(PathType.Continuation));
        assertEq(uint8(c.pathOf(2).pathType), uint8(PathType.Continuation));

        Ref memory tok = Ref(1, address(c), 7, RefKind.Token);
        vm.prank(artist);
        c.setPath(2, PathType.Migration, tok, bytes32(uint256(42)));
        assertEq(uint8(c.pathOf(2).pathType), uint8(PathType.Migration));
        assertEq(c.pathOf(2).data, bytes32(uint256(42)));
        assertEq(uint8(c.pathOf(1).pathType), uint8(PathType.Continuation)); // unaffected
    }

    function test_tokenPath_setPath_requiresMintedToken() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory ref = Ref(1, address(c), 0, RefKind.Collection);
        vm.expectRevert(ISovereignCollection.NotMinted.selector);
        vm.prank(artist);
        c.setPath(1, PathType.Burn, ref, bytes32(0));
    }

    function test_tokenPath_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        Ref memory ref = Ref(1, address(c), 0, RefKind.Collection);
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(collector);
        c.setPath(1, PathType.Burn, ref, bytes32(0));
    }

    function test_tokenPath_setDefaultPath_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        Ref memory ref = Ref(1, address(c), 0, RefKind.Collection);
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setDefaultPath(PathType.Burn, ref, bytes32(0));
    }

    // ── royaltyInfo ──────────────────────────────────────────────────────────

    function test_royaltyInfo() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        SovereignCollection c = _collection(cfg);
        vm.prank(collector);
        c.mint(1);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(c.supportsInterface(0x2a55205a));
    }

    function test_royaltyInfo_defaultsToOwner() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        SovereignCollection c = _collection(cfg);
        (address receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    // ── tokenURI delegation + contractURI ────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.tokenURI(1), renderer.tokenURI(address(c), 1));
    }

    function test_tokenURI_nonexistentReverts() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.tokenURI(1);
    }

    function test_tokenURI_customRendererOverride() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        c.setRenderer(address(custom));
        assertEq(c.tokenURI(1), custom.tokenURI(address(c), 1));
        assertEq(c.renderer(), address(custom));
    }

    function test_contractURI_delegatesToRenderer() public {
        SovereignCollection c = _collection(_freeConfig());
        assertEq(c.contractURI(), renderer.contractURI(address(c)));
    }

    function test_setRenderer_blockedWhenFrozen() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.freezeMetadata();
        vm.expectRevert(ISovereignCollection.MetadataIsFrozen.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_onlyOwner() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRenderer(makeAddr("newRenderer"));
    }

    // ── token artwork ────────────────────────────────────────────────────────

    function test_tokenArtwork_perTokenOverride() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(2);
        vm.prank(artist);
        c.setTokenArtwork(2, "ipfs://QmUnique");
        assertEq(c.tokenArtwork(2), "ipfs://QmUnique");
        assertEq(c.tokenArtwork(1), "");
    }

    function test_tokenArtwork_batch() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 3;
        string[] memory cids = new string[](2);
        cids[0] = "ipfs://one";
        cids[1] = "ipfs://three";
        vm.prank(artist);
        c.setTokenArtworkBatch(ids, cids);
        assertEq(c.tokenArtwork(1), "ipfs://one");
        assertEq(c.tokenArtwork(2), "");
        assertEq(c.tokenArtwork(3), "ipfs://three");
    }

    function test_tokenArtwork_batch_lengthMismatchReverts() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        uint256[] memory ids = new uint256[](2);
        string[] memory cids = new string[](1);
        vm.expectRevert(ISovereignCollection.LengthMismatch.selector);
        vm.prank(artist);
        c.setTokenArtworkBatch(ids, cids);
    }

    function test_tokenArtwork_requiresMintedToken() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotMinted.selector);
        vm.prank(artist);
        c.setTokenArtwork(1, "ipfs://Qm");
    }

    function test_tokenArtwork_blockedWhenFrozen() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        vm.prank(artist);
        c.freezeMetadata();
        vm.expectRevert(ISovereignCollection.MetadataIsFrozen.selector);
        vm.prank(artist);
        c.setTokenArtwork(1, "ipfs://QmNope");
    }

    // ── freezeMetadata / lockWork / isPermanent ──────────────────────────────

    function test_freezeMetadata_isOneWay() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.freezeMetadata();
        assertTrue(c.isMetadataFrozen());
        vm.expectRevert(ISovereignCollection.AlreadyFrozen.selector);
        vm.prank(artist);
        c.freezeMetadata();
    }

    function test_lockWork_isOneWay() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.lockWork();
        assertTrue(c.isWorkLocked());
        vm.expectRevert(ISovereignCollection.WorkAlreadyLocked.selector);
        vm.prank(artist);
        c.lockWork();
    }

    function test_isPermanent_requiresBothFreezeAndLock() public {
        SovereignCollection c = _collection(_freeConfig());
        assertFalse(c.isPermanent());

        vm.prank(artist);
        c.freezeMetadata();
        assertFalse(c.isPermanent()); // frozen but not locked

        vm.prank(artist);
        c.lockWork();
        assertTrue(c.isPermanent()); // both now true
    }

    // ── renounceOwnership disabled ────────────────────────────────────────────

    function test_renounceOwnership_disabled() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        vm.expectRevert(ISovereignCollection.RenounceDisabled.selector);
        c.renounceOwnership();
        assertEq(c.owner(), artist);
    }

    // ── Ownable2Step ─────────────────────────────────────────────────────────

    function test_ownable2Step_transferRequiresAcceptance() public {
        SovereignCollection c = _collection(_freeConfig());
        address newOwner = makeAddr("newOwner");

        vm.prank(artist);
        c.transferOwnership(newOwner);
        assertEq(c.owner(), artist); // not transferred until accepted
        assertEq(c.pendingOwner(), newOwner);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        c.acceptOwnership();

        vm.prank(newOwner);
        c.acceptOwnership();
        assertEq(c.owner(), newOwner);
    }

    // ── fuzz: payment split conservation ─────────────────────────────────────

    function testFuzz_splitIsExactAndConserved(uint96 priceRaw, uint8 qtyRaw) public {
        uint256 price = uint256(priceRaw);
        uint256 qty = bound(qtyRaw, 1, 50);

        address payout = makeAddr("fuzzPayout");
        address surf = makeAddr("fuzzReferrer");
        CollectionConfig memory cfg = _pricedConfig(price);
        cfg.payoutAddress = payout;
        SovereignCollection c = _collection(cfg); // fresh collection each run

        uint256 total = price * qty;
        address buyer = makeAddr("fuzzBuyer");
        vm.deal(buyer, total);
        vm.prank(buyer);
        c.mintWithReferral{value: total}(qty, surf, "");

        uint256 expectedReferrer = (total * 1000) / 10_000; // fixed 10%
        assertEq(c.pendingWithdrawal(surf), expectedReferrer, "referrer cut");
        assertEq(c.pendingWithdrawal(payout), total - expectedReferrer, "artist cut");
        assertEq(address(c).balance, total, "all funds held for withdrawal");
        assertEq(c.balanceOf(buyer), qty);
        // No wei lost or created: referrer + artist == total paid.
        assertEq(c.pendingWithdrawal(surf) + c.pendingWithdrawal(payout), total);
    }
}
