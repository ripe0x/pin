// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {FixedPriceMinterBase} from "./FixedPriceMinterBase.sol";
import {FixedPriceMinterHandler} from "./invariants/FixedPriceMinterHandler.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {FixedPriceMinter, FixedPriceMinterInitParams} from "../../../src/surface/minters/FixedPriceMinter.sol";

/// @title FixedPriceMinterInvariants
/// @notice Bounded random-walk invariant suite over ONE FixedPriceMinter
///         clone, driven by FixedPriceMinterHandler. See the handler for the
///         action set. Run recipe for a deep pass:
///
///           FOUNDRY_PROFILE=invariant forge test --match-path "test/surface/minters/invariants/*" --match-contract FixedPriceMinterInvariants
///
///         Default profile keeps runs/depth small so this suite stays part
///         of the fast day-to-day `forge test` loop; the invariant profile
///         (see foundry.toml) is for a deliberate deep pass.
contract FixedPriceMinterInvariants is StdInvariant, FixedPriceMinterBase {
    FixedPriceMinterHandler internal handler;
    Surface internal collection;
    FixedPriceMinter internal minter;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant MAX_MINTS = 60;

    function setUp() public override {
        super.setUp();

        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = MAX_MINTS;
        (collection, minter) = _collectionWithConfiguredMinter(p);

        handler = new FixedPriceMinterHandler(collection, minter, artist, PRICE, MAX_MINTS);

        // Only fuzz calls into the handler; the minter is reached exclusively through it.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = FixedPriceMinterHandler.mint.selector;
        selectors[1] = FixedPriceMinterHandler.withdraw.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ════════════════════════════════════════════════════════════════════
    // FUNDS: pull accounting is exact. The handler never force-feeds ETH (no
    // vm.deal to the minter address, no selfdestruct), so the minter's
    // balance must equal the sum of every ghost payee's pending balance, and
    // the sum of _pending must equal _totalPending (no stray or missing
    // wei), and paid-in must equal withdrawn + still-pending.
    // ════════════════════════════════════════════════════════════════════

    function invariant_balanceMatchesPendingSum() public view {
        uint256 sumPending = _sumGhostPending();
        assertEq(address(minter).balance, sumPending, "minter balance != sum(pendingWithdrawal)");
    }

    function invariant_totalPaidInEqualsWithdrawnPlusPending() public view {
        uint256 sumPending = _sumGhostPending();
        assertEq(
            handler.ghostTotalPaidIn(), handler.ghostTotalWithdrawn() + sumPending, "paidIn != withdrawn + pending"
        );
    }

    /// @dev No account's pendingWithdrawal ever exceeds what the ghost thinks
    ///      it is owed (and vice versa) — the contract and the ghost mirror
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
    // SUPPLY: the minter's own sale ceiling always binds.
    // ════════════════════════════════════════════════════════════════════

    function invariant_totalMintedNeverExceedsMaxMints() public view {
        assertTrue(minter.totalMinted() <= MAX_MINTS, "totalMinted exceeded maxMints");
        assertEq(minter.totalMinted(), handler.ghostMints(), "totalMinted diverged from ghost");
        assertTrue(collection.totalSupply() <= MAX_MINTS, "collection supply exceeded the minter's maxMints");
    }
}
