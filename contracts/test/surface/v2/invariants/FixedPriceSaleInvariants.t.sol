// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SurfaceV2Base} from "../SurfaceV2Base.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";
import {FixedPriceSaleHandler} from "./FixedPriceSaleHandler.sol";

contract FixedPriceSaleInvariantsTest is StdInvariant, SurfaceV2Base {
    FixedPriceSale internal sale;
    FixedPriceSaleHandler internal handler;

    function setUp() public override {
        super.setUp();
        (, sale) = _launch();
        handler = new FixedPriceSaleHandler(sale, artist, pnd);
        targetContract(address(handler));
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
        if (handler.closed()) assertEq(sale.totalMinted(), handler.mintedAtClose(), "minted after close");
        if (handler.renounced()) assertEq(sale.price(), handler.priceAtRenounce(), "price changed after renounce");
    }

    /// @dev Nobody withdraws more than they were credited.
    function invariant_noOverWithdrawal() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(handler.credited(a), handler.paidOut(a) + sale.pendingWithdrawal(a));
        }
    }
}
