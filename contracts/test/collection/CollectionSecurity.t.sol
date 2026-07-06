// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {
    MockMinter,
    ReenteringHook,
    ReenteringWithdrawer,
    MaliciousPriceStrategy,
    MockPriceStrategy
} from "./mocks/CollectionMocks.sol";

import {SovereignCollection} from "../../src/collection/SovereignCollection.sol";
import {ISovereignCollection} from "../../src/collection/interfaces/ISovereignCollection.sol";
import {CollectionConfig, InitParams, IdMode} from "../../src/collection/CollectionTypes.sol";

/// @dev Access-control matrix, reentrancy attempts, malicious-strategy
///      accounting invariants, and the double-init / implementation-cannot-
///      be-initialized guarantees.
contract CollectionSecurityTest is CollectionBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ════════════════════════════════════════════════════════════════════
    // Access control matrix: every onlyOwner / minter-gated / approval-gated
    // function, called by a wrong caller, must revert.
    // ════════════════════════════════════════════════════════════════════

    function test_accessControl_onlyOwnerFunctions() public {
        SovereignCollection c = _collection(_freeConfig());
        bytes memory unauth = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);

        vm.startPrank(stranger);

        vm.expectRevert(unauth);
        c.setClosing(true);

        vm.expectRevert(unauth);
        c.setRenderer(makeAddr("r"));

        vm.expectRevert(unauth);
        c.setMintHook(makeAddr("h"));

        vm.expectRevert(unauth);
        c.setPriceStrategy(makeAddr("s"));

        vm.expectRevert(unauth);
        c.setMinter(makeAddr("m"), true);

        vm.expectRevert(unauth);
        c.setPayoutAddress(stranger);

        vm.expectRevert(unauth);
        c.freezeMetadata();

        vm.expectRevert(unauth);
        c.lockWork();

        vm.expectRevert(unauth);
        c.rescueStrayETH(stranger);

        vm.stopPrank();
    }

    function test_accessControl_onlyOwnerFunctions_requireMintedToken() public {
        // setTokenArtwork / setTokenArtworkBatch / setPath revert on
        // "not minted" before the caller check would even matter for an
        // unminted id, so exercise them against a MINTED token to isolate
        // the access-control revert specifically.
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
        bytes memory unauth = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);

        vm.startPrank(stranger);

        vm.expectRevert(unauth);
        c.setTokenArtwork(1, "ipfs://nope");

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        string[] memory cids = new string[](1);
        cids[0] = "ipfs://nope";
        vm.expectRevert(unauth);
        c.setTokenArtworkBatch(ids, cids);

        vm.stopPrank();
    }

    function test_accessControl_minterGatedFunctions() public {
        SovereignCollection seq = _collection(_freeConfig());
        SovereignCollection pooled = _collection(_pooledConfig());

        vm.expectRevert(ISovereignCollection.NotMinter.selector);
        vm.prank(stranger);
        seq.mintTo(stranger, address(0), "");

        vm.expectRevert(ISovereignCollection.NotMinter.selector);
        vm.prank(stranger);
        pooled.mintToAt(stranger, 1, address(0), "");
    }

    function test_accessControl_burnRequiresOwnerOrApproved() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);

        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
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
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.burn(1);
    }

    // ════════════════════════════════════════════════════════════════════
    // Reentrancy: a malicious hook re-entering mint() from beforeMint or
    // afterMint must be blocked by nonReentrant, on every guarded entrypoint.
    // ════════════════════════════════════════════════════════════════════

    function test_reentrancy_hookReenteringMint_onBefore_blocked() public {
        SovereignCollection c = _collection(_freeConfig());
        ReenteringHook reenter = new ReenteringHook();
        vm.prank(artist);
        c.setMintHook(address(reenter));
        reenter.arm(ISovereignCollection(address(c)), true, false);

        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_reentrancy_hookReenteringMint_onAfter_blocked() public {
        SovereignCollection c = _collection(_freeConfig());
        ReenteringHook reenter = new ReenteringHook();
        vm.prank(artist);
        c.setMintHook(address(reenter));
        reenter.arm(ISovereignCollection(address(c)), false, true);

        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_reentrancy_withdrawReentrancyBlocked() public {
        ReenteringWithdrawer r = new ReenteringWithdrawer();
        CollectionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(r);
        SovereignCollection c = _collection(cfg);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        r.arm(ISovereignCollection(address(c)));
        // withdraw's internal call to r.receive() re-enters withdraw(); the
        // reentrant call reverts (guard), which bubbles up through the
        // outer `.call` as `ok == false`, which the outer withdraw()
        // reports as WithdrawFailed() rather than propagating the raw
        // ReentrancyGuardReentrantCall selector.
        vm.expectRevert(ISovereignCollection.WithdrawFailed.selector);
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
        CollectionConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(evil);
        SovereignCollection c = _collection(cfg);

        // quantity=2 (even) -> required = 2 * 1 ETH = 2 ETH
        vm.deal(collector, 10 ether);
        vm.prank(collector);
        c.mintWithRewards{value: 2 ether}(2, surface, "");
        uint256 total1 = 2 ether;
        uint256 expectedSurface1 = (total1 * 1000) / 10_000;
        assertEq(c.pendingWithdrawal(surface), expectedSurface1);
        assertEq(c.pendingWithdrawal(artist), total1 - expectedSurface1);
        assertEq(address(c).balance, total1, "balance == sum of both accruals for qty=2");

        // quantity=3 (odd) -> required = 3 * 2 ETH = 6 ETH
        vm.prank(collector);
        c.mintWithRewards{value: 6 ether}(3, surface, "");
        uint256 total2 = 6 ether;
        uint256 expectedSurfaceCumulative = ((total1 + total2) * 1000) / 10_000;
        assertEq(c.pendingWithdrawal(surface), expectedSurfaceCumulative);
        assertEq(address(c).balance, total1 + total2, "conservation holds across both mints");
    }

    function test_maliciousStrategy_underpaymentStillReverts() public {
        MaliciousPriceStrategy evil = new MaliciousPriceStrategy(1 ether, 1 ether);
        CollectionConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(evil);
        SovereignCollection c = _collection(cfg);

        vm.deal(collector, 1 ether);
        vm.expectRevert(ISovereignCollection.Underpayment.selector);
        vm.prank(collector);
        c.mintWithRewards{value: 0.5 ether}(1, surface, "");
    }

    function test_priceStrategy_overpaymentAccruesRefundToPayer() public {
        MockPriceStrategy strat = new MockPriceStrategy(1 ether);
        CollectionConfig memory cfg = _freeConfig();
        cfg.priceStrategy = address(strat);
        SovereignCollection c = _collection(cfg);

        vm.deal(collector, 2 ether);
        vm.prank(collector);
        c.mintWithRewards{value: 1.5 ether}(1, address(0), "");

        assertEq(c.pendingWithdrawal(artist), 1 ether); // exact required amount
        assertEq(c.pendingWithdrawal(collector), 0.5 ether); // excess refunded as pull
        assertEq(address(c).balance, 1.5 ether); // conservation: both balances sum to what was sent
    }

    // ════════════════════════════════════════════════════════════════════
    // Unauthorized mintTo / mintToAt in the wrong id mode.
    // ════════════════════════════════════════════════════════════════════

    function test_unauthorizedMinter_cannotMintTo() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotMinter.selector);
        vm.prank(stranger);
        c.mintTo(stranger, address(0), "");
    }

    function test_unauthorizedMinter_cannotMintToAt() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.expectRevert(ISovereignCollection.NotMinter.selector);
        vm.prank(stranger);
        c.mintToAt(stranger, 1, address(0), "");
    }

    function test_revokedMinter_losesAccess() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        assertTrue(c.isMinter(address(minter)));

        vm.prank(artist);
        c.setMinter(address(minter), false);
        assertFalse(c.isMinter(address(minter)));

        vm.expectRevert(ISovereignCollection.NotMinter.selector);
        minter.callMintTo(ISovereignCollection(address(c)), collector, address(0), "");
    }

    function test_setMinter_rejectsZeroAddress() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.ZeroMinter.selector);
        vm.prank(artist);
        c.setMinter(address(0), true);
    }

    // ════════════════════════════════════════════════════════════════════
    // Double-init rejection + implementation cannot be initialized.
    // ════════════════════════════════════════════════════════════════════

    function test_confirm_doubleInitReverts() public {
        SovereignCollection c = _collection(_freeConfig());
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
