// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {
    MockRenderer,
    RevertingPayee
} from "./mocks/CollectionMocks.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {ICollection} from "../../src/collection/interfaces/ICollection.sol";
import {
    CollectionConfig,
    CollectionStatus,
    IdMode,
    InitParams,
    MintMark
} from "../../src/collection/CollectionTypes.sol";

contract CollectionTest is CollectionBase {
    // ── init validation ──────────────────────────────────────────────────────

    function test_init_rejectsZeroOwner() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.owner = address(0);
        Collection clone = _freshClone();
        vm.expectRevert(ICollection.OwnerRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsZeroDefaultRenderer() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.defaultRenderer = address(0);
        Collection clone = _freshClone();
        vm.expectRevert(ICollection.RendererRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsRoyaltyTooHigh() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5001; // > 50% cap
        InitParams memory p = _rawInitParams(cfg);
        Collection clone = _freshClone();
        vm.expectRevert(ICollection.RoyaltyTooHigh.selector);
        clone.initialize(p);
    }

    function test_init_allowsRoyaltyAtCap() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5000; // exactly 50%, allowed
        Collection c = _collection(cfg);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // defaults to owner when royaltyReceiver unset
        assertEq(amount, 0.5 ether);
    }

    function test_init_rejectsBadWindow_endBeforeStart() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 200;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        Collection clone = _freshClone();
        vm.expectRevert(ICollection.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_rejectsBadWindow_endEqualsStart() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        Collection clone = _freshClone();
        vm.expectRevert(ICollection.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_allowsOpenEndedWindow() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 0; // open-ended is fine regardless of start
        Collection c = _collection(cfg);
        (CollectionConfig memory readCfg,,) = c.config();
        assertEq(readCfg.mintStart, 100);
        assertEq(readCfg.mintEnd, 0);
    }

    function test_init_rejectsZeroInitialMinter() public {
        CollectionConfig memory cfg = _pooledConfig();
        address[] memory minters = new address[](1);
        minters[0] = address(0);
        vm.expectRevert(ICollection.ZeroMinter.selector);
        _collectionWithMinters(cfg, minters);
    }

    function test_init_grantsInitialMinters() public {
        CollectionConfig memory cfg = _pooledConfig();
        address m = makeAddr("initialMinter");
        address[] memory minters = new address[](1);
        minters[0] = m;
        Collection c = _collectionWithMinters(cfg, minters);
        assertTrue(c.isMinter(m));
    }

    // ── config views ─────────────────────────────────────────────────────────

    function test_configReadable() public {
        Collection c = _collection(_pricedConfig(0.05 ether));
        (CollectionConfig memory cfg, CollectionStatus status, uint256 minted) = c.config();
        assertEq(cfg.price, 0.05 ether);
        assertEq(uint8(status), uint8(CollectionStatus.Open));
        assertEq(minted, 0);
    }

    function test_factory_deploysOwnedClone() public {
        Collection c = _collection(_freeConfig());
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
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.ownerOf(1), collector);
        assertEq(c.totalSupply(), 1);
    }

    function test_idMode_reads() public {
        Collection seq = _collection(_freeConfig());
        assertEq(uint8(seq.idMode()), uint8(IdMode.Sequential));
        Collection pooled = _collection(_pooledConfig());
        assertEq(uint8(pooled.idMode()), uint8(IdMode.Pooled));
    }

    // ── paid mint happy paths ────────────────────────────────────────────────

    function test_mint_gasOnly_succeeds() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3);
        assertEq(c.balanceOf(collector), 3);
        assertEq(c.ownerOf(3), collector);
        assertEq(c.totalSupply(), 3);
    }

    function test_mint_zeroQuantityReverts() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.ZeroQuantity.selector);
        vm.prank(collector);
        c.mint(0);
    }

    function test_mint_gasOnly_rejectsValue() public {
        Collection c = _collection(_freeConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(ICollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 1 wei}(1);
    }

    function test_mint_pooledRejectsPaidPath() public {
        Collection c = _collection(_pooledConfig());
        vm.expectRevert(ICollection.PooledSellsViaMinter.selector);
        vm.prank(collector);
        c.mint(1);
    }

    // ── exact-payment enforcement ────────────────────────────────────────────

    function test_mint_priced_requiresExactValue_under() public {
        Collection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(ICollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 0.05 ether}(1);
    }

    function test_mint_priced_requiresExactValue_over() public {
        Collection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(ICollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 0.2 ether}(1);
    }

    function test_mint_priced_exactValueSucceeds() public {
        Collection c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 0.3 ether);
        vm.prank(collector);
        c.mint{value: 0.3 ether}(3);
        assertEq(c.balanceOf(collector), 3);
    }

    // ── referral share math ───────────────────────────────────────────────────

    function test_simpleMint_foldsFullPriceToArtist() public {
        // mint(quantity) defaults referrer to 0 -> artist gets 100%.
        Collection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(artist), 1 ether);
        assertEq(address(c).balance, 1 ether); // held until withdraw
    }

    function test_mintWithReferral_fixedTenPercentSplit() public {
        Collection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 2 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 2 ether}(2, referrer, ""); // 2 tokens * 1 ETH

        assertEq(c.pendingWithdrawal(referrer), 0.2 ether); // fixed 10% of 2 ETH
        assertEq(c.pendingWithdrawal(artist), 1.8 ether); // remainder to artist payout
        assertEq(c.balanceOf(collector), 2);
    }

    function test_mintWithReferral_zeroReferrerFoldsToArtist() public {
        Collection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, address(0), "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_selfHostReferrerKeepsEverything() public {
        // Artist passes their OWN address as referrer: the 10% comes back to
        // them too (100% total).
        Collection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, artist, "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_referralShare_exactBpsMath() public {
        Collection c = _collection(_pricedConfig(1 ether));
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
        Collection c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(payout), 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_setPayoutAddress_routesFutureAccrualsOnly() public {
        Collection c = _collection(_pricedConfig(1 ether));
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
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPayoutAddress(stranger);
    }

    // ── pull withdrawals ─────────────────────────────────────────────────────

    function test_withdraw_sendsToOwedAccount() public {
        Collection c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        uint256 before = artist.balance;
        c.withdraw(artist); // permissionless trigger; funds go to the owed address
        assertEq(artist.balance - before, 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_withdraw_nothingReverts() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NothingToWithdraw.selector);
        c.withdraw(stranger);
    }

    function test_withdraw_rejectsZeroAccount() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.ZeroAccount.selector);
        c.withdraw(address(0));
    }

    function test_revertingPayeeCannotBrickMint() public {
        // A reverting payee no longer bricks minting (pull payments). It only
        // fails that recipient's own withdraw.
        RevertingPayee bad = new RevertingPayee();
        CollectionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(bad);
        Collection c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1); // succeeds despite the payee being unable to receive ETH
        assertEq(c.balanceOf(collector), 1);
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);

        vm.expectRevert(ICollection.WithdrawFailed.selector);
        c.withdraw(address(bad));

        // Funds remain intact and claimable if the payee later routes payout
        // elsewhere (a stuck payee does not lose its own accrual, it just
        // cannot self-serve the pull; the balance stays owed to it forever).
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);
    }

    function test_pendingWithdrawal_accumulatesAcrossMints() public {
        Collection c = _collection(_pricedConfig(1 ether));
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
        Collection c = _collection(_pricedConfig(1 ether));
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

        vm.expectRevert(ICollection.NoStrayETH.selector);
        vm.prank(artist);
        c.rescueStrayETH(dest);
    }

    function test_rescueStrayETH_onlyOwner() public {
        Collection c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.rescueStrayETH(stranger);
    }

    function test_rescueStrayETH_rejectsZeroAccount() public {
        Collection c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ICollection.ZeroAccount.selector);
        vm.prank(artist);
        c.rescueStrayETH(address(0));
    }

    // ── mint window: rescheduling + derived status ────────────────────────────

    /// @dev The window is a live setting; lifecycle status is derived from it and
    ///      the clock, never stored. Pushing the start into the future flips the
    ///      derived status to Scheduled and closes the paid path until it opens.
    function test_setMintWindow_reschedulesAndDerivesStatus() public {
        Collection c = _collection(_freeConfig()); // open now, open-ended
        (, CollectionStatus statusBefore,) = c.config();
        assertEq(uint8(statusBefore), uint8(CollectionStatus.Open));

        uint64 start = uint64(block.timestamp + 100);
        uint64 end = uint64(block.timestamp + 200);
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.MintWindowSet(start, end);
        vm.prank(artist);
        c.setMintWindow(start, end);

        (CollectionConfig memory cfg, CollectionStatus scheduled,) = c.config();
        assertEq(cfg.mintStart, start);
        assertEq(cfg.mintEnd, end);
        assertEq(uint8(scheduled), uint8(CollectionStatus.Scheduled), "pre-start reads Scheduled");

        vm.expectRevert(ICollection.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        // inside the window it is Open again and the Minted event stamps Open.
        vm.warp(start);
        (, CollectionStatus open,) = c.config();
        assertEq(uint8(open), uint8(CollectionStatus.Open));
        vm.expectEmit(true, true, false, true, address(c));
        emit ICollection.Minted(
            collector, address(0), 1, 1, 0, uint48(block.number), CollectionStatus.Open
        );
        vm.prank(collector);
        c.mint(1);
    }

    /// @dev `isFinal` is derived live, so reopening a window that had ended
    ///      un-finalizes prior tokens.
    function test_setMintWindow_reopenUnfinalizes() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintEnd = uint64(block.timestamp + 100);
        Collection c = _collection(cfg);

        vm.prank(collector);
        c.mint(1);
        assertFalse(c.mintMarkOf(1).isFinal, "within window: not final");

        vm.warp(cfg.mintEnd); // window ended
        (, CollectionStatus closed,) = c.config();
        assertEq(uint8(closed), uint8(CollectionStatus.Closed));
        assertTrue(c.mintMarkOf(1).isFinal, "last token of a closed window is final");

        vm.prank(artist);
        c.setMintWindow(0, uint64(block.timestamp + 100)); // reopen
        (, CollectionStatus reopened,) = c.config();
        assertEq(uint8(reopened), uint8(CollectionStatus.Open));
        assertFalse(c.mintMarkOf(1).isFinal, "reopened window un-finalizes prior tokens");
    }

    function test_setMintWindow_rejectsBadWindow() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.BadMintWindow.selector);
        vm.prank(artist);
        c.setMintWindow(200, 100); // end <= start and end != 0
    }

    function test_setMintWindow_onlyOwnerOrAdmin() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setMintWindow(0, 0);
    }

    /// @dev An authorized extension minter may mint before the public window
    ///      opens; its Minted event truthfully stamps Scheduled (status is
    ///      derived at mint time and event-only — never stored per token).
    function test_scheduledStatus_onEarlyExtensionMint() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        Collection c = _collection(cfg);

        address minter = makeAddr("earlyMinter");
        vm.prank(artist);
        c.setMinter(minter, true);

        // the paid path is closed before the public window opens...
        vm.expectRevert(ICollection.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        // ...but the authorized minter mints, and the event says Scheduled.
        vm.expectEmit(true, true, false, true, address(c));
        emit ICollection.Minted(
            collector, address(0), 1, 1, 0, uint48(block.number), CollectionStatus.Scheduled
        );
        vm.prank(minter);
        c.mintTo(collector, address(0), "");
    }

    // ── supply cap (sequential) ──────────────────────────────────────────────

    function test_mint_capEnforced_sequential() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        Collection c = _collection(cfg);

        vm.prank(collector);
        c.mint(2);
        vm.expectRevert(ICollection.ExceedsCap.selector);
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
        Collection c = _collection(cfg);

        vm.expectRevert(ICollection.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 100); // past mintEnd
        vm.expectRevert(ICollection.MintEnded.selector);
        vm.prank(collector);
        c.mint(1);
    }

    // ── live settings: price, royalty, supply cap + lock ────────────────────

    function test_setPrice_updatesPaidPath() public {
        Collection c = _collection(_pricedConfig(0.1 ether));
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.PriceSet(0.05 ether);
        vm.prank(artist);
        c.setPrice(0.05 ether);

        // old price now reverts (exact-match protects the collector)...
        vm.deal(collector, 1 ether);
        vm.expectRevert(ICollection.WrongPayment.selector);
        vm.prank(collector);
        c.mint{value: 0.1 ether}(1);

        // ...and the new price mints.
        vm.prank(collector);
        c.mint{value: 0.05 ether}(1);
        (CollectionConfig memory cfg,,) = c.config();
        assertEq(cfg.price, 0.05 ether, "config() reports the live price");
    }

    function test_setPrice_onlyOwnerOrAdmin() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPrice(1 ether);
    }

    function test_setRoyalty_updatesAndCaps() public {
        Collection c = _collection(_freeConfig());
        address newReceiver = makeAddr("newRoyalty");
        vm.expectEmit(true, false, false, true, address(c));
        emit ICollection.RoyaltySet(750, newReceiver);
        vm.prank(artist);
        c.setRoyalty(750, newReceiver);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, newReceiver);
        assertEq(amount, 0.075 ether);

        // the init-time cap binds the setter too
        vm.expectRevert(ICollection.RoyaltyTooHigh.selector);
        vm.prank(artist);
        c.setRoyalty(5001, newReceiver);

        // receiver 0 falls back to owner()
        vm.prank(artist);
        c.setRoyalty(100, address(0));
        (receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    function test_setRoyalty_onlyOwnerOrAdmin() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRoyalty(100, address(0));
    }

    function test_setSupplyCap_updatesAndFloors() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        Collection c = _collection(cfg);
        vm.prank(collector);
        c.mint(3);

        // cannot set below mints-ever (sequential: ids are never reused)
        vm.expectRevert(ICollection.BadSupplyCap.selector);
        vm.prank(artist);
        c.setSupplyCap(2);

        // shrink to exactly minted: collection closes
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.SupplyCapSet(3);
        vm.prank(artist);
        c.setSupplyCap(3);
        (, CollectionStatus status,) = c.config();
        assertEq(uint8(status), uint8(CollectionStatus.Closed));
        vm.expectRevert(ICollection.ExceedsCap.selector);
        vm.prank(collector);
        c.mint(1);

        // grow re-opens; 0 = open supply
        vm.prank(artist);
        c.setSupplyCap(0);
        vm.prank(collector);
        c.mint(10);
        assertEq(c.totalSupply(), 13);
    }

    function test_lockSupply_freezesCapForever() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 100;
        Collection c = _collection(cfg);
        assertFalse(c.isSupplyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ICollection.SupplyLocked();
        vm.prank(artist);
        c.lockSupply();
        assertTrue(c.isSupplyLocked());

        vm.expectRevert(ICollection.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(200);

        // one-way: locking twice reverts rather than silently re-emitting
        vm.expectRevert(ICollection.SupplyIsLocked.selector);
        vm.prank(artist);
        c.lockSupply();
    }

    function test_supplyCapAndLock_onlyOwnerOrAdmin() public {
        Collection c = _collection(_freeConfig());
        vm.startPrank(stranger);
        vm.expectRevert(ICollection.NotAuthorized.selector);
        c.setSupplyCap(1);
        vm.expectRevert(ICollection.NotAuthorized.selector);
        c.lockSupply();
        vm.stopPrank();
    }

    /// @dev The cap binds the extension paths too (_checkCap on every mint
    ///      path), so a locked cap is a hard ceiling regardless of minters.
    function test_lockedCap_bindsExtensionMinters() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 1;
        Collection c = _collection(cfg);
        address minter = makeAddr("minter");
        vm.startPrank(artist);
        c.setMinter(minter, true);
        c.lockSupply();
        vm.stopPrank();

        vm.prank(minter);
        c.mintTo(collector, address(0), "");
        vm.expectRevert(ICollection.ExceedsCap.selector);
        vm.prank(minter);
        c.mintTo(collector, address(0), "");
    }

    // ── ERC-4906 refresh signals ─────────────────────────────────────────────

    function test_erc4906_interfaceAndSetterSignals() public {
        Collection c = _collection(_freeConfig());
        assertTrue(c.supportsInterface(0x49064906));

        // renderer swap refreshes everything
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));

        // work swap refreshes everything
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.setWork(_emptyWork());
    }

    function test_erc4906_tokenArtworkSignalsPerToken() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        string[] memory cids = new string[](2);
        cids[0] = "ipfs://a";
        cids[1] = "ipfs://b";
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.MetadataUpdate(1);
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.MetadataUpdate(2);
        vm.prank(artist);
        c.setTokenArtworkBatch(ids, cids);
        assertEq(c.tokenArtwork(2), "ipfs://b");
    }

    /// @dev The renderer (or owner/admin) can signal refreshes the core cannot
    ///      see (ChainLive works, reveals) — including after freezeMetadata,
    ///      because freeze locks the renderer pointer, not a live work's output.
    function test_notifyMetadataUpdate_rendererAndAdminOnly() public {
        Collection c = _collection(_freeConfig());

        // the default renderer may signal
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.BatchMetadataUpdate(1, 10);
        vm.prank(address(renderer));
        c.notifyMetadataUpdate(1, 10);

        // the owner may signal, even after freeze
        vm.prank(artist);
        c.freezeMetadata();
        vm.expectEmit(false, false, false, true, address(c));
        emit ICollection.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.notifyMetadataUpdate(0, type(uint256).max);

        // strangers may not
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.notifyMetadataUpdate(1, 1);
    }

    // ── royaltyInfo ──────────────────────────────────────────────────────────

    function test_royaltyInfo() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        Collection c = _collection(cfg);
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
        Collection c = _collection(cfg);
        (address receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    // ── tokenURI delegation + contractURI ────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.tokenURI(1), renderer.tokenURI(address(c), 1));
    }

    function test_tokenURI_nonexistentReverts() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.tokenURI(1);
    }

    function test_tokenURI_customRendererOverride() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        c.setRenderer(address(custom));
        assertEq(c.tokenURI(1), custom.tokenURI(address(c), 1));
        assertEq(c.renderer(), address(custom));
    }

    function test_contractURI_delegatesToRenderer() public {
        Collection c = _collection(_freeConfig());
        assertEq(c.contractURI(), renderer.contractURI(address(c)));
    }

    function test_setRenderer_blockedWhenFrozen() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.freezeMetadata();
        vm.expectRevert(ICollection.MetadataIsFrozen.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_onlyOwner() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRenderer(makeAddr("newRenderer"));
    }

    // ── token artwork ────────────────────────────────────────────────────────

    function test_tokenArtwork_perTokenOverride() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(2);
        vm.prank(artist);
        c.setTokenArtworkBatch(_ids1(2), _cids1("ipfs://QmUnique"));
        assertEq(c.tokenArtwork(2), "ipfs://QmUnique");
        assertEq(c.tokenArtwork(1), "");
    }

    /// @dev Single-token batch builders (the single-token setter was folded
    ///      into the batch; a single token is a batch of one).
    function _ids1(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _cids1(string memory cid) internal pure returns (string[] memory cids) {
        cids = new string[](1);
        cids[0] = cid;
    }

    function test_tokenArtwork_batch() public {
        Collection c = _collection(_freeConfig());
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
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        uint256[] memory ids = new uint256[](2);
        string[] memory cids = new string[](1);
        vm.expectRevert(ICollection.LengthMismatch.selector);
        vm.prank(artist);
        c.setTokenArtworkBatch(ids, cids);
    }

    function test_tokenArtwork_requiresMintedToken() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotMinted.selector);
        vm.prank(artist);
        c.setTokenArtworkBatch(_ids1(1), _cids1("ipfs://Qm"));
    }

    function test_tokenArtwork_blockedWhenFrozen() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        vm.prank(artist);
        c.freezeMetadata();
        vm.expectRevert(ICollection.MetadataIsFrozen.selector);
        vm.prank(artist);
        c.setTokenArtworkBatch(_ids1(1), _cids1("ipfs://QmNope"));
    }

    // ── freezeMetadata / lockWork / isPermanent ──────────────────────────────

    function test_freezeMetadata_isOneWay() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.freezeMetadata();
        assertTrue(c.isMetadataFrozen());
        vm.expectRevert(ICollection.AlreadyFrozen.selector);
        vm.prank(artist);
        c.freezeMetadata();
    }

    function test_lockWork_isOneWay() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.lockWork();
        assertTrue(c.isWorkLocked());
        vm.expectRevert(ICollection.WorkAlreadyLocked.selector);
        vm.prank(artist);
        c.lockWork();
    }

    function test_isPermanent_requiresBothFreezeAndLock() public {
        Collection c = _collection(_freeConfig());
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
        Collection c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        vm.expectRevert(ICollection.RenounceDisabled.selector);
        c.renounceOwnership();
        assertEq(c.owner(), artist);
    }

    // ── Ownable2Step ─────────────────────────────────────────────────────────

    function test_ownable2Step_transferRequiresAcceptance() public {
        Collection c = _collection(_freeConfig());
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
        Collection c = _collection(cfg); // fresh collection each run

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
