// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockRenderer, RevertingPayee} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../src/surface/SurfaceFactory.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig, SurfaceStatus, IdMode, InitParams} from "../../src/surface/SurfaceTypes.sol";

contract SurfaceTest is SurfaceBase {
    // ── init validation ──────────────────────────────────────────────────────

    function test_init_rejectsZeroOwner() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.owner = address(0);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.OwnerRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsZeroDefaultRenderer() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.defaultRenderer = address(0);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        clone.initialize(p);
    }

    /// @dev A renderer with no code would brick tokenURI — fatally so when
    ///      the collection is born rendererLocked. Refused at the door.
    function test_init_rejectsNonContractRenderer() public {
        address eoa = makeAddr("eoaRenderer");
        SurfaceConfig memory cfg = _freeConfig();
        cfg.renderer = eoa;
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        clone.initialize(p);

        // The born-locked variant is the one the guard exists for: without it
        // this collection could never render and never be fixed.
        cfg.rendererLocked = true;
        p = _rawInitParams(cfg);
        clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        clone.initialize(p);
    }

    function test_setRenderer_rejectsNonContract() public {
        Surface c = _collection(_freeConfig());
        address eoa = makeAddr("eoaRenderer");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        vm.prank(artist);
        c.setRenderer(eoa);
    }

    function test_init_rejectsRoyaltyTooHigh() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5001; // > 50% cap
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.RoyaltyTooHigh.selector);
        clone.initialize(p);
    }

    function test_init_allowsRoyaltyAtCap() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5000; // exactly 50%, allowed
        Surface c = _collection(cfg);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // defaults to owner when royaltyReceiver unset
        assertEq(amount, 0.5 ether);
    }

    function test_init_rejectsBadWindow_endBeforeStart() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintStart = 200;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_rejectsBadWindow_endEqualsStart() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 100;
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.BadMintWindow.selector);
        clone.initialize(p);
    }

    function test_init_allowsOpenEndedWindow() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintStart = 100;
        cfg.mintEnd = 0; // open-ended is fine regardless of start
        Surface c = _collection(cfg);
        (SurfaceConfig memory readCfg,,) = c.config();
        assertEq(readCfg.mintStart, 100);
        assertEq(readCfg.mintEnd, 0);
    }

    function test_init_rejectsZeroInitialMinter() public {
        SurfaceConfig memory cfg = _freeConfig();
        address[] memory minters = new address[](1);
        minters[0] = address(0);
        vm.expectRevert(ISurfaceCore.ZeroMinter.selector);
        _pooledWithMinters(cfg, minters);
    }

    function test_init_grantsInitialMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        address m = makeAddr("initialMinter");
        address[] memory minters = new address[](1);
        minters[0] = m;
        PooledSurface c = _pooledWithMinters(cfg, minters);
        assertTrue(c.isMinter(m));
    }

    // ── config views ─────────────────────────────────────────────────────────

    function test_configReadable() public {
        Surface c = _collection(_pricedConfig(0.05 ether));
        (SurfaceConfig memory cfg, SurfaceStatus status, uint256 minted) = c.config();
        assertEq(cfg.price, 0.05 ether);
        assertEq(uint8(status), uint8(SurfaceStatus.Open));
        assertEq(minted, 0);
    }

    function test_factory_deploysOwnedClone() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.owner(), artist);
        assertEq(c.name(), "Artist Surface");
        assertEq(c.symbol(), "ACOL");
        assertTrue(factory.isSurface(address(c)));
        assertEq(factory.totalSurfaces(), 1);
        assertEq(c.REFERRAL_SHARE_BPS(), 1000);
        assertFalse(c.isRendererLocked());
        assertFalse(c.isSupplyLocked());
    }

    function test_startTokenIdIsOne() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.ownerOf(1), collector);
        assertEq(c.totalSupply(), 1);
    }

    function test_idMode_reads() public {
        Surface seq = _collection(_freeConfig());
        assertEq(uint8(seq.idMode()), uint8(IdMode.Sequential));
        PooledSurface pooled = _pooled(_freeConfig());
        assertEq(uint8(pooled.idMode()), uint8(IdMode.Pooled));
    }

    // ── paid mint happy paths ────────────────────────────────────────────────

    function test_mint_gasOnly_succeeds() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3);
        assertEq(c.balanceOf(collector), 3);
        assertEq(c.ownerOf(3), collector);
        assertEq(c.totalSupply(), 3);
    }

    function test_mint_zeroQuantityReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroQuantity.selector);
        vm.prank(collector);
        c.mint(0);
    }

    function test_mint_gasOnly_rejectsValue() public {
        Surface c = _collection(_freeConfig());
        vm.deal(collector, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.WrongPayment.selector, 0, 1 wei));
        vm.prank(collector);
        c.mint{value: 1 wei}(1);
    }

    /// @dev The pooled form has no paid path at all — the entrypoint does
    ///      not exist, so the call dies in the dispatcher, not in a check.
    function test_mint_pooledRejectsPaidPath() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(collector);
        (bool ok,) = address(c).call(abi.encodeWithSignature("mint(uint256)", uint256(1)));
        assertFalse(ok, "pooled must not expose mint");
    }

    // ── exact-payment enforcement ────────────────────────────────────────────

    function test_mint_priced_requiresExactValue_under() public {
        Surface c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.WrongPayment.selector, 0.1 ether, 0.05 ether));
        vm.prank(collector);
        c.mint{value: 0.05 ether}(1);
    }

    function test_mint_priced_requiresExactValue_over() public {
        Surface c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.WrongPayment.selector, 0.1 ether, 0.2 ether));
        vm.prank(collector);
        c.mint{value: 0.2 ether}(1);
    }

    function test_mint_priced_exactValueSucceeds() public {
        Surface c = _collection(_pricedConfig(0.1 ether));
        vm.deal(collector, 0.3 ether);
        vm.prank(collector);
        c.mint{value: 0.3 ether}(3);
        assertEq(c.balanceOf(collector), 3);
    }

    // ── referral share math ───────────────────────────────────────────────────

    function test_simpleMint_foldsFullPriceToArtist() public {
        // mint(quantity) defaults referrer to 0 -> artist gets 100%.
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(artist), 1 ether);
        assertEq(address(c).balance, 1 ether); // held until withdraw
    }

    function test_mintWithReferral_fixedTenPercentSplit() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.setReferrer(referrer, true); // artist opts the referrer in
        vm.deal(collector, 2 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 2 ether}(2, referrer, ""); // 2 tokens * 1 ETH

        assertEq(c.pendingWithdrawal(referrer), 0.2 ether); // fixed 10% of 2 ETH
        assertEq(c.pendingWithdrawal(artist), 1.8 ether); // remainder to artist payout
        assertEq(c.balanceOf(collector), 2);
    }

    function test_mintWithReferral_zeroReferrerFoldsToArtist() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, address(0), "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_unapprovedReferrer_foldsFullPriceToArtist() public {
        // A referrer the artist never approved earns nothing: the whole price
        // folds to the artist. This is the default, so an artist who never
        // touches setReferrer keeps 100% on every mint.
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, referrer, "");
        assertEq(c.pendingWithdrawal(referrer), 0, "unapproved referrer earns nothing");
        assertEq(c.pendingWithdrawal(artist), 1 ether, "artist keeps the full price");
    }

    function test_buyerCannotSelfReferToSkimShare() public {
        // The buyer names their OWN address as referrer to try to claw back the
        // share. Since the buyer is not approved, they earn nothing and the
        // artist keeps 100%.
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, collector, "");
        assertEq(c.pendingWithdrawal(collector), 0, "self-referral earns nothing");
        assertEq(c.pendingWithdrawal(artist), 1 ether, "artist keeps the full price");
    }

    function test_selfHost_artistApprovesOwnAddress() public {
        // A self-hosting artist opts their own address in, so the share routes
        // back to them: 100% total, by explicit choice rather than by leak.
        Surface c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.setReferrer(artist, true);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1 ether}(1, artist, "");
        assertEq(c.pendingWithdrawal(artist), 1 ether);
    }

    function test_referralShare_exactBpsMath() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.setReferrer(referrer, true);
        vm.deal(collector, 10 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 10 ether}(10, referrer, "");
        assertEq(c.pendingWithdrawal(referrer), 1 ether); // 10% of 10 ETH
        assertEq(c.pendingWithdrawal(artist), 9 ether);
    }

    function test_setReferrer_ownerOnlyAndZeroRejected() public {
        Surface c = _collection(_pricedConfig(1 ether));
        // A non-owner cannot approve referrers.
        vm.prank(collector);
        vm.expectRevert();
        c.setReferrer(collector, true);
        // Zero can never be approved.
        vm.prank(artist);
        vm.expectRevert(ISurfaceCore.ZeroAccount.selector);
        c.setReferrer(address(0), true);
        // Approve then revoke round-trips the read.
        vm.prank(artist);
        c.setReferrer(referrer, true);
        assertTrue(c.isApprovedReferrer(referrer));
        vm.prank(artist);
        c.setReferrer(referrer, false);
        assertFalse(c.isApprovedReferrer(referrer));
    }

    // ── payout address routing ───────────────────────────────────────────────

    function test_mint_customPayout() public {
        address payout = makeAddr("payout");
        SurfaceConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = payout;
        Surface c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(payout), 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_setPayoutAddress_routesFutureAccrualsOnly() public {
        Surface c = _collection(_pricedConfig(1 ether));
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
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPayoutAddress(stranger);
    }

    // ── pull withdrawals ─────────────────────────────────────────────────────

    function test_withdraw_sendsToOwedAccount() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        uint256 before = artist.balance;
        c.withdraw(artist); // permissionless trigger; funds go to the owed address
        assertEq(artist.balance - before, 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    function test_withdraw_nothingReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NothingToWithdraw.selector);
        c.withdraw(stranger);
    }

    function test_withdraw_rejectsZeroAccount() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroAccount.selector);
        c.withdraw(address(0));
    }

    function test_revertingPayeeCannotBrickMint() public {
        // A reverting payee no longer bricks minting (pull payments). It only
        // fails that recipient's own withdraw.
        RevertingPayee bad = new RevertingPayee();
        SurfaceConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(bad);
        Surface c = _collection(cfg);
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1); // succeeds despite the payee being unable to receive ETH
        assertEq(c.balanceOf(collector), 1);
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);

        vm.expectRevert(ISurfaceCore.WithdrawFailed.selector);
        c.withdraw(address(bad));

        // Funds remain intact and claimable if the payee later routes payout
        // elsewhere (a stuck payee does not lose its own accrual, it just
        // cannot self-serve the pull; the balance stays owed to it forever).
        assertEq(c.pendingWithdrawal(address(bad)), 1 ether);
    }

    function test_pendingWithdrawal_accumulatesAcrossMints() public {
        Surface c = _collection(_pricedConfig(1 ether));
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
        Surface c = _collection(_pricedConfig(1 ether));
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

        vm.expectRevert(ISurfaceCore.NoStrayETH.selector);
        vm.prank(artist);
        c.rescueStrayETH(dest);
    }

    function test_rescueStrayETH_onlyOwner() public {
        Surface c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.rescueStrayETH(stranger);
    }

    function test_rescueStrayETH_rejectsZeroAccount() public {
        Surface c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceCore.ZeroAccount.selector);
        vm.prank(artist);
        c.rescueStrayETH(address(0));
    }

    // ── mint window: rescheduling + derived status ────────────────────────────

    /// @dev The window is a live setting; lifecycle status is derived from it and
    ///      the clock, never stored. Pushing the start into the future flips the
    ///      derived status to Scheduled and closes the paid path until it opens.
    function test_setMintWindow_reschedulesAndDerivesStatus() public {
        Surface c = _collection(_freeConfig()); // open now, open-ended
        (, SurfaceStatus statusBefore,) = c.config();
        assertEq(uint8(statusBefore), uint8(SurfaceStatus.Open));

        uint64 start = uint64(block.timestamp + 100);
        uint64 end = uint64(block.timestamp + 200);
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.MintWindowSet(start, end);
        vm.prank(artist);
        c.setMintWindow(start, end);

        (SurfaceConfig memory cfg, SurfaceStatus scheduled,) = c.config();
        assertEq(cfg.mintStart, start);
        assertEq(cfg.mintEnd, end);
        assertEq(uint8(scheduled), uint8(SurfaceStatus.Scheduled), "pre-start reads Scheduled");

        vm.expectRevert(ISurfaceCore.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        // inside the window it is Open again and the Minted event stamps Open.
        vm.warp(start);
        (, SurfaceStatus open,) = c.config();
        assertEq(uint8(open), uint8(SurfaceStatus.Open));
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 1, 1, 0, SurfaceStatus.Open);
        vm.prank(collector);
        c.mint(1);
    }

    /// @dev Status is derived live, so reopening a window that had ended
    ///      flips Closed back to Open — and with it everything renderers
    ///      derive from status (a "Final mint" trait un-finalizes; see the
    ///      DefaultRenderer tests for the trait-level assertion).
    function test_setMintWindow_reopenFlipsDerivedStatus() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintEnd = uint64(block.timestamp + 100);
        Surface c = _collection(cfg);

        vm.prank(collector);
        c.mint(1);

        vm.warp(cfg.mintEnd); // window ended
        (, SurfaceStatus closed,) = c.config();
        assertEq(uint8(closed), uint8(SurfaceStatus.Closed));

        vm.prank(artist);
        c.setMintWindow(0, uint64(block.timestamp + 100)); // reopen
        (, SurfaceStatus reopened,) = c.config();
        assertEq(uint8(reopened), uint8(SurfaceStatus.Open));
    }

    function test_setMintWindow_rejectsBadWindow() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.BadMintWindow.selector);
        vm.prank(artist);
        c.setMintWindow(200, 100); // end <= start and end != 0
    }

    function test_setMintWindow_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setMintWindow(0, 0);
    }

    /// @dev An authorized extension minter may mint before the public window
    ///      opens; its Minted event truthfully stamps Scheduled (status is
    ///      derived at mint time and event-only — never stored per token).
    function test_scheduledStatus_onEarlyExtensionMint() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        Surface c = _collection(cfg);

        address minter = makeAddr("earlyMinter");
        vm.prank(artist);
        c.setMinter(minter, true);

        // the paid path is closed before the public window opens...
        vm.expectRevert(ISurfaceCore.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        // ...but the authorized minter mints, and the event says Scheduled.
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 1, 1, 0, SurfaceStatus.Scheduled);
        vm.prank(minter);
        c.mintTo(collector, address(0), "");
    }

    // ── supply cap (sequential) ──────────────────────────────────────────────

    function test_mint_capEnforced_sequential() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        Surface c = _collection(cfg);

        vm.prank(collector);
        c.mint(2);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 3, 4));
        vm.prank(collector);
        c.mint(2);
        vm.prank(collector);
        c.mint(1);

        (, SurfaceStatus status, uint256 minted) = c.config();
        assertEq(minted, 3);
        assertEq(uint8(status), uint8(SurfaceStatus.Closed));
    }

    // ── mint window ──────────────────────────────────────────────────────────

    function test_mint_windowEnforced() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.mintStart = uint64(block.timestamp + 100);
        cfg.mintEnd = uint64(block.timestamp + 200);
        Surface c = _collection(cfg);

        vm.expectRevert(ISurfaceCore.MintNotStarted.selector);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 150);
        vm.prank(collector);
        c.mint(1);

        vm.warp(block.timestamp + 100); // past mintEnd
        vm.expectRevert(ISurfaceCore.MintEnded.selector);
        vm.prank(collector);
        c.mint(1);
    }

    // ── live settings: price, royalty, supply cap + lock ────────────────────

    function test_setPrice_updatesPaidPath() public {
        Surface c = _collection(_pricedConfig(0.1 ether));
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.PriceSet(0.05 ether);
        vm.prank(artist);
        c.setPrice(0.05 ether);

        // old price now reverts (exact-match protects the collector)...
        vm.deal(collector, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.WrongPayment.selector, 0.05 ether, 0.1 ether));
        vm.prank(collector);
        c.mint{value: 0.1 ether}(1);

        // ...and the new price mints.
        vm.prank(collector);
        c.mint{value: 0.05 ether}(1);
        (SurfaceConfig memory cfg,,) = c.config();
        assertEq(cfg.price, 0.05 ether, "config() reports the live price");
    }

    function test_setPrice_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPrice(1 ether);
    }

    function test_setRoyalty_updatesAndCaps() public {
        Surface c = _collection(_freeConfig());
        address newReceiver = makeAddr("newRoyalty");
        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceCore.RoyaltySet(750, newReceiver);
        vm.prank(artist);
        c.setRoyalty(750, newReceiver);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, newReceiver);
        assertEq(amount, 0.075 ether);

        // the init-time cap binds the setter too
        vm.expectRevert(ISurfaceCore.RoyaltyTooHigh.selector);
        vm.prank(artist);
        c.setRoyalty(5001, newReceiver);

        // receiver 0 falls back to owner()
        vm.prank(artist);
        c.setRoyalty(100, address(0));
        (receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    function test_setRoyalty_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRoyalty(100, address(0));
    }

    function test_setSupplyCap_updatesAndFloors() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        Surface c = _collection(cfg);
        vm.prank(collector);
        c.mint(3);

        // cannot set below mints-ever (sequential: ids are never reused)
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.BadSupplyCap.selector, 3, 2));
        vm.prank(artist);
        c.setSupplyCap(2);

        // shrink to exactly minted: collection closes
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.SupplyCapSet(3);
        vm.prank(artist);
        c.setSupplyCap(3);
        (, SurfaceStatus status,) = c.config();
        assertEq(uint8(status), uint8(SurfaceStatus.Closed));
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 3, 4));
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
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 100;
        Surface c = _collection(cfg);
        assertFalse(c.isSupplyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceCore.SupplyLocked();
        vm.prank(artist);
        c.lockSupply();
        assertTrue(c.isSupplyLocked());

        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(200);

        // one-way: locking twice reverts rather than silently re-emitting
        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.lockSupply();
    }

    function test_supplyCapAndLock_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(stranger);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.setSupplyCap(1);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.lockSupply();
        vm.stopPrank();
    }

    /// @dev The cap binds the extension paths too (_checkCap on every mint
    ///      path), so a locked cap is a hard ceiling regardless of minters.
    function test_lockedCap_bindsExtensionMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 1;
        Surface c = _collection(cfg);
        address minter = makeAddr("minter");
        vm.startPrank(artist);
        c.setMinter(minter, true);
        c.lockSupply();
        vm.stopPrank();

        vm.prank(minter);
        c.mintTo(collector, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 1, 2));
        vm.prank(minter);
        c.mintTo(collector, address(0), "");
    }

    // ── ERC-4906 refresh signals ─────────────────────────────────────────────

    function test_erc4906_interfaceAndSetterSignals() public {
        Surface c = _collection(_freeConfig());
        assertTrue(c.supportsInterface(0x49064906));

        // renderer swap refreshes every token AND the contract-level page
        address newRenderer = address(new MockRenderer());
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.ContractURIUpdated();
        vm.prank(artist);
        c.setRenderer(newRenderer);
    }

    /// @dev The renderer (or owner/admin) can signal refreshes the core cannot
    ///      see (chain-live works, reveals, refreshed captures in
    ///      RenderAssets) — including after lockRenderer, because the lock
    ///      pins the pointer, not a live work's output.
    function test_notifyMetadataUpdate_rendererAndAdminOnly() public {
        Surface c = _collection(_freeConfig());

        // the default renderer may signal
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(1, 10);
        vm.prank(address(renderer));
        c.notifyMetadataUpdate(1, 10);

        // the owner may signal, even after the renderer is locked
        vm.prank(artist);
        c.lockRenderer();
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.notifyMetadataUpdate(0, type(uint256).max);

        // strangers may not
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.notifyMetadataUpdate(1, 1);
    }

    // ── royaltyInfo ──────────────────────────────────────────────────────────

    function test_royaltyInfo() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        Surface c = _collection(cfg);
        vm.prank(collector);
        c.mint(1);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(c.supportsInterface(0x2a55205a));
    }

    function test_royaltyInfo_defaultsToOwner() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        Surface c = _collection(cfg);
        (address receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    // ── tokenURI delegation + contractURI ────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        assertEq(c.tokenURI(1), renderer.tokenURI(address(c), 1));
    }

    function test_tokenURI_nonexistentReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.tokenURI(1);
    }

    function test_tokenURI_customRendererOverride() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        c.setRenderer(address(custom));
        assertEq(c.tokenURI(1), custom.tokenURI(address(c), 1));
        assertEq(c.renderer(), address(custom));
    }

    function test_contractURI_delegatesToRenderer() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.contractURI(), renderer.contractURI(address(c)));
    }

    function test_setRenderer_blockedWhenLocked() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.lockRenderer();
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_onlyOwner() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_rejectsZeroAddress() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        vm.prank(artist);
        c.setRenderer(address(0));
    }

    function test_init_resolvesRendererSlot() public {
        // No choice made: the factory default fills the slot.
        Surface c = _collection(_freeConfig());
        assertEq(c.renderer(), address(renderer));
        (SurfaceConfig memory cfg,,) = c.config();
        assertEq(cfg.renderer, address(renderer));

        // An explicit choice at init wins over the default.
        MockRenderer custom = new MockRenderer();
        SurfaceConfig memory cfg2 = _freeConfig();
        cfg2.renderer = address(custom);
        Surface c2 = _collection(cfg2);
        assertEq(c2.renderer(), address(custom));
    }

    /// @dev Locks passed true in the config take effect at init: the
    ///      collection is born locked, no second transaction to remember.
    function test_init_bornLocked() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        cfg.rendererLocked = true;
        cfg.supplyLocked = true;
        Surface c = _collection(cfg);

        assertTrue(c.isRendererLocked());
        assertTrue(c.isSupplyLocked());
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(10);
    }

    function test_version() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.version(), 1);
    }

    // ── token artwork ────────────────────────────────────────────────────────

    // ── lockRenderer (one-way, optional) ─────────────────────────────────────

    function test_lockRenderer_isOneWayAndOptional() public {
        Surface c = _collection(_freeConfig());
        assertFalse(c.isRendererLocked(), "not locked by default");

        // still swappable before the lock
        address beforeLock = address(new MockRenderer());
        vm.prank(artist);
        c.setRenderer(beforeLock);

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceCore.RendererLocked();
        vm.prank(artist);
        c.lockRenderer();
        assertTrue(c.isRendererLocked());

        // one-way: locking twice reverts
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.lockRenderer();
    }

    // ── factory deprecation (one-way kill switch for NEW deploys) ────────────

    function test_factory_deprecate_stopsNewDeploysOnly() public {
        // pre-deprecation deploys work; the deployer is this test contract
        Surface existing = _collection(_freeConfig());

        address successor = makeAddr("factoryV2");
        vm.expectEmit(true, false, false, false, address(factory));
        emit SurfaceFactory.Deprecated(successor);
        factory.deprecate(successor);
        assertTrue(factory.deprecated());
        assertEq(factory.successor(), successor);

        // new deploys revert...
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurface("After", "AFT", artist, _freeConfig(), none, none);

        // ...existing collections are untouched (immutable by design)
        vm.prank(collector);
        existing.mint(1);
        assertEq(existing.ownerOf(1), collector);

        // one-way, deployer-only
        vm.expectRevert(SurfaceFactory.AlreadyDeprecated.selector);
        factory.deprecate(address(0));
        vm.expectRevert(SurfaceFactory.NotDeployer.selector);
        vm.prank(stranger);
        factory.deprecate(address(0));
    }

    // ── factory pause (reversible off/on for NEW deploys) ────────────────────

    function test_factory_pause_isReversibleAndDeployerOnly() public {
        // baseline: a deploy works
        _collection(_freeConfig());
        assertFalse(factory.paused());

        // pause → new deploys revert; existing collections untouched
        vm.expectEmit(false, false, false, true, address(factory));
        emit SurfaceFactory.PausedSet(true);
        factory.setPaused(true);
        assertTrue(factory.paused());
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryPaused.selector);
        factory.createSurface("Paused", "PAU", artist, _freeConfig(), none, none);

        // resume → deploys work again (the reversible part `deprecate` can't do)
        factory.setPaused(false);
        assertFalse(factory.paused());
        _collection(_freeConfig()); // no revert

        // deployer-only
        vm.expectRevert(SurfaceFactory.NotDeployer.selector);
        vm.prank(stranger);
        factory.setPaused(true);
    }

    function test_factory_deprecate_overrides_unpause() public {
        factory.deprecate(address(0));
        // even explicitly un-pausing can't revive a deprecated factory
        factory.setPaused(false);
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurface("Nope", "NOP", artist, _freeConfig(), none, none);
    }

    // ── renounceOwnership disabled ────────────────────────────────────────────

    function test_renounceOwnership_disabled() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        vm.expectRevert(ISurfaceCore.RenounceDisabled.selector);
        c.renounceOwnership();
        assertEq(c.owner(), artist);
    }

    // ── Ownable2Step ─────────────────────────────────────────────────────────

    function test_ownable2Step_transferRequiresAcceptance() public {
        Surface c = _collection(_freeConfig());
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
        SurfaceConfig memory cfg = _pricedConfig(price);
        cfg.payoutAddress = payout;
        Surface c = _collection(cfg); // fresh collection each run
        vm.prank(artist);
        c.setReferrer(surf, true); // approved referrer earns the share

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
