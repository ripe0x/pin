// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {
    MockMinter,
    ReenteringHook,
    ReenteringWithdrawer,
    MaliciousPriceStrategy,
    MockPriceStrategy
} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig, InitParams, IdMode} from "../../src/surface/SurfaceTypes.sol";

/// @dev Access-control matrix, reentrancy attempts, malicious-strategy
///      accounting invariants, and the double-init / implementation-cannot-
///      be-initialized guarantees.
contract SurfaceSecurityTest is SurfaceBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ════════════════════════════════════════════════════════════════════
    // Access control matrix: every owner-or-admin / minter-gated /
    // approval-gated function, called by a wrong caller (neither owner nor
    // admin), must revert NotAuthorized.
    // ════════════════════════════════════════════════════════════════════

    function test_accessControl_onlyOwnerFunctions() public {
        Surface c = _collection(_freeConfig());
        bytes memory unauth = abi.encodeWithSelector(ISurfaceCore.NotAuthorized.selector);

        vm.startPrank(stranger);

        vm.expectRevert(unauth);
        c.setMintWindow(0, 0);

        vm.expectRevert(unauth);
        c.setRenderer(makeAddr("r"));

        vm.expectRevert(unauth);
        c.setMintHook(makeAddr("h"));

        vm.expectRevert(unauth);
        c.setPriceStrategy(makeAddr("s"));

        vm.expectRevert(unauth);
        c.setMinter(makeAddr("m"), true);

        vm.expectRevert(unauth);
        c.setPrice(1 ether);

        vm.expectRevert(unauth);
        c.setRoyalty(100, stranger);

        vm.expectRevert(unauth);
        c.setSupplyCap(1);

        vm.expectRevert(unauth);
        c.lockSupply();

        vm.expectRevert(unauth);
        c.notifyMetadataUpdate(1, 1);

        vm.expectRevert(unauth);
        c.setPayoutAddress(stranger);

        vm.expectRevert(unauth);
        c.lockRenderer();

        vm.expectRevert(unauth);
        c.rescueStrayETH(stranger);

        vm.stopPrank();
    }

    function test_accessControl_minterGatedFunctions() public {
        Surface seq = _collection(_freeConfig());
        PooledSurface pooled = _pooled(_freeConfig());

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        seq.mintTo(stranger, address(0), "");

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        pooled.mintToId(stranger, 1, address(0), "");
    }

    function test_accessControl_burnRequiresOwnerOrApproved() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);

        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.burn(1);

        // approved operator CAN burn
        vm.prank(collector);
        c.approve(stranger, 1);
        vm.prank(stranger);
        c.burn(1);
        assertEq(c.balanceOf(collector), 0);
    }

    function test_accessControl_burnRequiresExistingToken() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.burn(1);
    }

    // ════════════════════════════════════════════════════════════════════
    // Reentrancy: a malicious hook re-entering mint() from beforeMint or
    // afterMint must be blocked by nonReentrant, on every guarded entrypoint.
    // ════════════════════════════════════════════════════════════════════

    function test_reentrancy_hookReenteringMint_onBefore_blocked() public {
        Surface c = _collection(_freeConfig());
        ReenteringHook reenter = new ReenteringHook();
        vm.prank(artist);
        c.setMintHook(address(reenter));
        reenter.arm(ISurface(address(c)), true, false);

        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_reentrancy_hookReenteringMint_onAfter_blocked() public {
        Surface c = _collection(_freeConfig());
        ReenteringHook reenter = new ReenteringHook();
        vm.prank(artist);
        c.setMintHook(address(reenter));
        reenter.arm(ISurface(address(c)), false, true);

        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_reentrancy_withdrawReentrancyBlocked() public {
        ReenteringWithdrawer r = new ReenteringWithdrawer();
        SurfaceConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(r);
        Surface c = _collection(cfg);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        r.arm(ISurface(address(c)));
        // withdraw's internal call to r.receive() re-enters withdraw(); the
        // reentrant call reverts (guard), which bubbles up through the
        // outer `.call` as `ok == false`, which the outer withdraw()
        // reports as WithdrawFailed() rather than propagating the raw
        // ReentrancyGuardReentrantCall selector.
        vm.expectRevert(ISurfaceCore.WithdrawFailed.selector);
        r.pull();
        // Balance is untouched: the reentrant attempt did not partially drain.
        assertEq(c.pendingWithdrawal(address(r)), 1 ether);
    }

    // ════════════════════════════════════════════════════════════════════
    // Malicious price strategy: a strategy that would answer differently
    // across calls cannot desync the accounting split from what was
    // actually paid in, because the core reads priceOf() exactly once per
    // mint and reuses that value for both the `required` check and settle().
    // ════════════════════════════════════════════════════════════════════

    function test_maliciousStrategy_singleReadInvariant_holdsAcrossQuantityParity() public {
        // even quantity -> 1 ETH/token quote; odd -> 2 ETH/token quote. The
        // "attack" would be: quote low, settle high (or vice versa) by
        // answering differently between the `required` computation and the
        // settlement split. Since both derive from ONE read, no such split
        // is possible regardless of which branch the strategy takes.
        MaliciousPriceStrategy evil = new MaliciousPriceStrategy(1 ether, 2 ether);
        SurfaceConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(evil);
        Surface c = _collection(cfg);

        // quantity=2 (even) -> required = 2 * 1 ETH = 2 ETH
        vm.deal(collector, 10 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 2 ether}(2, referrer, "");
        uint256 total1 = 2 ether;
        uint256 expectedReferrer1 = (total1 * 1000) / 10_000;
        assertEq(c.pendingWithdrawal(referrer), expectedReferrer1);
        assertEq(c.pendingWithdrawal(artist), total1 - expectedReferrer1);
        assertEq(address(c).balance, total1, "balance == sum of both accruals for qty=2");

        // quantity=3 (odd) -> required = 3 * 2 ETH = 6 ETH
        vm.prank(collector);
        c.mintWithReferral{value: 6 ether}(3, referrer, "");
        uint256 total2 = 6 ether;
        uint256 expectedReferrerCumulative = ((total1 + total2) * 1000) / 10_000;
        assertEq(c.pendingWithdrawal(referrer), expectedReferrerCumulative);
        assertEq(address(c).balance, total1 + total2, "conservation holds across both mints");
    }

    function test_maliciousStrategy_underpaymentStillReverts() public {
        MaliciousPriceStrategy evil = new MaliciousPriceStrategy(1 ether, 1 ether);
        SurfaceConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(evil);
        Surface c = _collection(cfg);

        vm.deal(collector, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.Underpayment.selector, 1 ether, 0.5 ether));
        vm.prank(collector);
        c.mintWithReferral{value: 0.5 ether}(1, referrer, "");
    }

    function test_priceStrategy_overpaymentAccruesRefundToPayer() public {
        MockPriceStrategy strat = new MockPriceStrategy(1 ether);
        SurfaceConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(strat);
        Surface c = _collection(cfg);

        vm.deal(collector, 2 ether);
        vm.prank(collector);
        c.mintWithReferral{value: 1.5 ether}(1, address(0), "");

        assertEq(c.pendingWithdrawal(artist), 1 ether); // exact required amount
        assertEq(c.pendingWithdrawal(collector), 0.5 ether); // excess refunded as pull
        assertEq(address(c).balance, 1.5 ether); // conservation: both balances sum to what was sent
    }

    // ════════════════════════════════════════════════════════════════════
    // Unauthorized mintTo / mintToId (each on its own form).
    // ════════════════════════════════════════════════════════════════════

    function test_unauthorizedMinter_cannotMintTo() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        c.mintTo(stranger, address(0), "");
    }

    function test_unauthorizedMinter_cannotMintToId() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        c.mintToId(stranger, 1, address(0), "");
    }

    function test_revokedMinter_losesAccess() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        assertTrue(c.isMinter(address(minter)));

        vm.prank(artist);
        c.setMinter(address(minter), false);
        assertFalse(c.isMinter(address(minter)));

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        minter.callMintTo(ISurface(address(c)), collector, address(0), "");
    }

    function test_setMinter_rejectsZeroAddress() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroMinter.selector);
        vm.prank(artist);
        c.setMinter(address(0), true);
    }

    // ════════════════════════════════════════════════════════════════════
    // Double-init rejection + implementation cannot be initialized.
    // ════════════════════════════════════════════════════════════════════

    function test_confirm_doubleInitReverts() public {
        Surface c = _collection(_freeConfig());
        InitParams memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        c.initialize(p);
    }

    function test_confirm_implCannotBeInitialized() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        impl.initialize(p);
    }
}
