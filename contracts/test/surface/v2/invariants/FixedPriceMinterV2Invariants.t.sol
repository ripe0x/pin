// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {FactoryMinterV2Base} from "../FactoryMinterV2Base.sol";
import {FixedPriceMinterV2Handler} from "./FixedPriceMinterV2Handler.sol";

import {SurfaceV2} from "../../../../src/surface/v2/SurfaceV2.sol";
import {
    FixedPriceMinterV2,
    FixedPriceMinterV2InitParams
} from "../../../../src/surface/v2/minters/FixedPriceMinterV2.sol";

/// @title FixedPriceMinterV2Invariants
/// @notice Bounded random-walk invariant suite over ONE FixedPriceMinterV2
///         clone, driven by FixedPriceMinterV2Handler. Run recipe for a deep
///         pass:
///
///           FOUNDRY_PROFILE=invariant forge test --match-path "test/surface/v2/invariants/*" --match-contract FixedPriceMinterV2Invariants
///
///         Default profile keeps runs/depth small so this suite stays part
///         of the fast day-to-day `forge test` loop; the invariant profile
///         (see foundry.toml) is for a deliberate deep pass.
///
///         FixedPriceMinterV2 has no public _totalPending getter (unlike the
///         internal accounting it maintains), so "the pending sum matches
///         the total the contract believes is owed" is asserted against
///         ghost-tracked truth (paid in minus withdrawn) rather than a
///         direct storage read; the two are equivalent by construction since
///         the handler mirrors every settle and withdraw the contract does.
contract FixedPriceMinterV2Invariants is StdInvariant, FactoryMinterV2Base {
    FixedPriceMinterV2Handler internal handler;
    SurfaceV2 internal collection;
    FixedPriceMinterV2 internal minter;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant MAX_MINTS = 60;

    function setUp() public override {
        super.setUp();

        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = MAX_MINTS;
        (collection, minter) = _collectionWithConfiguredMinter(p);

        handler = new FixedPriceMinterV2Handler(collection, minter, artist, PRICE, MAX_MINTS);

        // Only fuzz calls into the handler; the minter is reached exclusively through it.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = FixedPriceMinterV2Handler.mint.selector;
        selectors[1] = FixedPriceMinterV2Handler.withdraw.selector;
        selectors[2] = FixedPriceMinterV2Handler.setPrice.selector;
        selectors[3] = FixedPriceMinterV2Handler.setMintWindow.selector;
        selectors[4] = FixedPriceMinterV2Handler.setWalletCap.selector;
        selectors[5] = FixedPriceMinterV2Handler.setMaxMints.selector;
        selectors[6] = FixedPriceMinterV2Handler.setReferralShareBps.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ════════════════════════════════════════════════════════════════════
    // FUNDS: pull accounting is exact. The handler never force-feeds ETH (no
    // vm.deal to the minter address, no selfdestruct), so the minter's
    // balance must equal the sum of every ghost payee's pending balance, and
    // paid-in must equal withdrawn plus still-pending (the "_pending sum ==
    // _totalPending" invariant, checked against ghost truth since
    // _totalPending has no public getter).
    // ════════════════════════════════════════════════════════════════════

    function invariant_pendingSumMatchesPaidInMinusWithdrawn() public view {
        uint256 sumPending = _sumGhostPending();
        assertEq(
            sumPending,
            handler.ghostTotalPaidIn() - handler.ghostTotalWithdrawn(),
            "sum(pendingWithdrawal) != paidIn - withdrawn"
        );
    }

    /// @dev Contract balance covers everything owed. No stray ETH enters
    ///      through this handler, so equality holds in practice; the
    ///      invariant is phrased as >= to state the load-bearing guarantee
    ///      (the minter can always pay out what it owes) without depending
    ///      on the absence of a force-fed balance elsewhere.
    function invariant_balanceCoversPending() public view {
        uint256 sumPending = _sumGhostPending();
        assertTrue(address(minter).balance >= sumPending, "minter balance < sum(pendingWithdrawal)");
    }

    /// @dev withdraw() pays exactly _pending[account] and zeroes it; over
    ///      the life of the run, cumulative withdrawn per payee can never
    ///      exceed cumulative accrued per payee.
    function invariant_withdrawNeverExceedsOwed() public view {
        uint256 n = handler.ghostPayeeCount();
        for (uint256 i = 0; i < n; i++) {
            address payee = handler.ghostPayeesEver(i);
            assertTrue(
                handler.ghostWithdrawnEver(payee) <= handler.ghostAccruedEver(payee),
                "withdrawn exceeds ever-accrued for a payee"
            );
        }
    }

    /// @dev No account's pendingWithdrawal ever exceeds what the ghost thinks
    ///      it is owed (and vice versa): the contract and the ghost mirror
    ///      exactly, so nobody can ever withdraw more than accrued.
    function invariant_noAccountOwedMoreThanGhostTracks() public view {
        uint256 n = handler.ghostPayeeCount();
        for (uint256 i = 0; i < n; i++) {
            address payee = handler.ghostPayeesEver(i);
            assertEq(minter.pendingWithdrawal(payee), handler.ghostPending(payee), "pending diverged from ghost");
        }
    }

    function _sumGhostPending() internal view returns (uint256 sum) {
        uint256 n = handler.ghostPayeeCount();
        for (uint256 i = 0; i < n; i++) {
            sum += minter.pendingWithdrawal(handler.ghostPayeesEver(i));
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // REFERRAL: the share is capped at MAX_REFERRAL_SHARE_BPS (10%) on every
    // write (setReferralShareBps is not a fuzzed action here, but the
    // contract enforces the cap unconditionally), so the cut on any single
    // mint never exceeds total/10; summed across the run,
    // ghostTotalReferralPaid * 10 <= ghostTotalPaidIn.
    // ════════════════════════════════════════════════════════════════════

    function invariant_referralCutNeverExceedsTenPercentOfGross() public view {
        assertTrue(
            handler.ghostTotalReferralPaid() * 10 <= handler.ghostTotalPaidIn(),
            "cumulative referral payout exceeds 10% of cumulative gross"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // SUPPLY: the minter's own sale ceiling always binds. maxMints is a
    // fuzzed config-mutation target (setMaxMints), so the ceiling checked
    // here is the LIVE value, not the MAX_MINTS constant setUp() seeded it
    // with; a maxMints of 0 (unlimited) is a legal state a run can reach.
    // ════════════════════════════════════════════════════════════════════

    function invariant_totalMintedNeverExceedsMaxMints() public view {
        uint256 liveMax = minter.maxMints();
        if (liveMax != 0 && !handler.ghostMaxMintsEverLoweredBelowMinted()) {
            assertTrue(minter.totalMinted() <= liveMax, "totalMinted exceeded the live maxMints");
            assertTrue(collection.totalSupply() <= liveMax, "collection supply exceeded the live maxMints");
        }
        assertEq(minter.totalMinted(), handler.ghostMints(), "totalMinted diverged from ghost");
    }
}
