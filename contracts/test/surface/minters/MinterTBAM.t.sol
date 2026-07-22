// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {FixedPriceMinterBase} from "./FixedPriceMinterBase.sol";
import {FixedPriceMinter, FixedPriceMinterInitParams} from "../../../src/surface/minters/FixedPriceMinter.sol";
import {IPriceStrategy} from "../../../src/surface/interfaces/IPriceStrategy.sol";
import {Surface} from "../../../src/surface/Surface.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reference fixture: TBAM-shaped dynamic pricing sold through the minter
// slot, trimmed from the deleted token-level MiniTBAM fixture
// (contracts/test/surface/reference/MiniTBAM.t.sol under the fat-token
// architecture). That fixture also exercised token-level mint hooks and a
// per-block frame renderer; both are token concerns unrelated to this
// rearchitecture (hooks are deleted, the renderer is unaffected) and are
// out of scope here. What ports: the price strategy slot expressing dynamic
// pricing as a pure view of basefee x collective state, now read by
// FixedPriceMinter instead of the token, with the read-once/pull-refund
// guarantee unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Stand-in for a companion contract whose state a price strategy reads
///      (TBAM's per-collection lock count). Any address may lock; the
///      minter-facing behavior under test is the pricing curve, not the
///      companion's own authorization.
contract LockCounter {
    mapping(address => uint256) public effectiveLocks;

    function lock(address collection) external {
        effectiveLocks[collection] += 1;
    }
}

/// @dev basefee x unit gas x (1 + effectiveLocks), read through the minter's
///      priceStrategy slot exactly as the fat token used to read it directly.
contract LockCurvePriceStrategy is IPriceStrategy {
    LockCounter public immutable lockCounter;
    uint256 public constant UNIT_GAS = 60_000;

    constructor(LockCounter lockCounter_) {
        lockCounter = lockCounter_;
    }

    function priceOf(address collection, address, uint256 quantity)
        external
        view
        override
        returns (uint256)
    {
        return block.basefee * UNIT_GAS * (1 + lockCounter.effectiveLocks(collection)) * quantity;
    }
}

contract MinterTBAMTest is FixedPriceMinterBase {
    Surface internal collection;
    FixedPriceMinter internal minter;
    LockCounter internal lockCounter;
    LockCurvePriceStrategy internal strategy;

    function setUp() public override {
        super.setUp();
        lockCounter = new LockCounter();
        strategy = new LockCurvePriceStrategy(lockCounter);

        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (collection, minter) = _collectionWithConfiguredMinter(p);

        vm.fee(10 gwei);
        vm.deal(collector, 1000 ether);
        vm.deal(referrer, 1000 ether);
    }

    function test_priceTracksBasefee() public {
        vm.fee(10 gwei);
        uint256 p1 = minter.priceOf(collector, 1);
        assertEq(p1, 10 gwei * 60_000);

        vm.fee(30 gwei);
        assertEq(minter.priceOf(collector, 1), 3 * p1);
    }

    function test_priceClimbsWithLocks() public {
        uint256 before = minter.priceOf(collector, 1);

        lockCounter.lock(address(collection));
        uint256 afterOne = minter.priceOf(collector, 1);
        assertEq(afterOne, 2 * before, "one lock doubles the linear curve");

        lockCounter.lock(address(collection));
        assertEq(minter.priceOf(collector, 1), 3 * before);
    }

    function test_dynamicPriceMint_mintsThroughCollectionAndRefundsExcess() public {
        uint256 quote = minter.priceOf(collector, 1);
        vm.prank(collector);
        minter.mint{value: quote + 0.5 ether}(collector, 1, address(0), "");

        assertEq(collection.ownerOf(1), collector, "TBAM-shaped pricing sells through the minter's mintTo call");
        assertEq(minter.pendingWithdrawal(collector), 0.5 ether, "excess accrues as pull-refund to the payer");
        assertEq(minter.pendingWithdrawal(artist), quote);
    }

    function test_dynamicPriceMint_withReferral() public {
        lockCounter.lock(address(collection));
        uint256 quote = minter.priceOf(collector, 1);

        vm.prank(collector);
        minter.mint{value: quote}(collector, 1, referrer, "");

        uint256 refCut = (quote * minter.referralShareBps()) / 10_000;
        assertEq(minter.pendingWithdrawal(referrer), refCut);
        assertEq(minter.pendingWithdrawal(artist), quote - refCut);
    }
}
