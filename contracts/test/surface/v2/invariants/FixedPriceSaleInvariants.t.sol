// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SurfaceV2Base} from "../SurfaceV2Base.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";
import {FixedPriceSaleHandler} from "./FixedPriceSaleHandler.sol";

contract FixedPriceSaleInvariantsTest is StdInvariant, SurfaceV2Base {
    Surface internal token;
    FixedPriceSale internal sale;
    FixedPriceSaleHandler internal handler;

    function setUp() public override {
        super.setUp();
        (token, sale) = _launch();
        handler = new FixedPriceSaleHandler(sale, token, artist, pnd);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = FixedPriceSaleHandler.mint.selector;
        selectors[1] = FixedPriceSaleHandler.mintWithReferral.selector;
        selectors[2] = FixedPriceSaleHandler.withdraw.selector;
        selectors[3] = FixedPriceSaleHandler.withdrawTo.selector;
        selectors[4] = FixedPriceSaleHandler.setPrice.selector;
        selectors[5] = FixedPriceSaleHandler.setPayoutRecipient.selector;
        selectors[6] = FixedPriceSaleHandler.setMaxMints.selector;
        selectors[7] = FixedPriceSaleHandler.setWalletCap.selector;
        selectors[8] = FixedPriceSaleHandler.probeMaxMintsCap.selector;
        selectors[9] = FixedPriceSaleHandler.close.selector;
        selectors[10] = FixedPriceSaleHandler.renounce.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Value conservation: what is owed equals what came in minus what
    ///      went out, and the sale holds exactly that.
    function invariant_valueConserved() public view {
        uint256 owed = handler.ghostPaidIn() - handler.ghostWithdrawn();
        assertEq(handler.pendingSum(), owed, "pending != paid in - withdrawn");
        assertEq(address(sale).balance, owed, "balance != pending");
    }

    /// @dev Once closed, the sale never mints again; once the collection is
    ///      renounced, the sale's config never changes again.
    function invariant_closedAndRenouncedAreFinal() public view {
        if (handler.ghostCloses() != 0) assertEq(sale.totalMinted(), handler.mintedAtClose(), "minted after close");
        if (handler.ghostRenounces() != 0) assertEq(sale.price(), handler.priceAtRenounce(), "price changed after renounce");
    }

    /// @dev Nobody withdraws more than they were credited.
    function invariant_noOverWithdrawal() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(handler.credited(a), handler.paidOut(a) + sale.pendingWithdrawal(a));
        }
    }

    function invariant_closeAndRenounceArePermanent() public view {
        if (handler.ghostCloses() != 0) assertTrue(sale.closed());
        if (handler.ghostRenounces() != 0) assertEq(token.owner(), address(0));
    }

    /// @dev The same actions targeted by the deep invariant campaign are
    ///      driven once deterministically so an absent path fails visibly.
    function test_handlerReachability() public {
        handler.mint(2, 1);
        assertEq(handler.ghostSuccessfulMints(), 1);
        handler.probeMaxMintsCap();
        assertEq(handler.ghostCapRejections(), 1);
        handler.withdraw(1); // PND's referral balance
        assertEq(handler.ghostWithdrawalCalls(), 1);
        handler.close(0);
        assertEq(handler.ghostCloses(), 1);
        assertTrue(sale.closed());
        handler.renounce(0);
        assertEq(handler.ghostRenounces(), 1);
        assertEq(token.owner(), address(0));
        handler.withdraw(0); // payout survives both locks
        assertEq(handler.ghostWithdrawalCalls(), 2);
        assertEq(address(sale).balance, 0);
    }
}
