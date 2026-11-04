// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2_1} from "../src/SovereignAuctionHouseV2_1.sol";
import {SovereignAuctionHouseV2_1Factory} from "../src/SovereignAuctionHouseV2_1Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Test, MutableERC721, GasHungryERC721} from "./SovereignAuctionHouseV2.t.sol";
import {
    Sovereign1155AuctionHouseTest,
    RejectingERC1155Bidder,
    BareERC1155Bidder
} from "./Sovereign1155AuctionHouse.t.sol";
import {GasBurningBidder} from "./SovereignAuctionHouseV2_1.t.sol";

/// @dev Runs every SovereignAuctionHouseV2 ERC721 test against a V2.1 house.
///      The overrides below are the tests whose expected outcome changes by
///      design in V2.1: a delivery that fails only for the winner's address,
///      while the lot itself is transferable, now settles the sale and holds
///      the lot for the winner instead of deferring it toward a refund.
contract SovereignAuctionHouseV2_1CompatTest is SovereignAuctionHouseV2Test {
    function _newHouse(address owner) internal override returns (SovereignAuctionHouseV2) {
        SovereignAuctionHouseV2_1 impl = new SovereignAuctionHouseV2_1();
        SovereignAuctionHouseV2_1Factory f = new SovereignAuctionHouseV2_1Factory(address(impl), treasury, 250);
        vm.prank(owner);
        return SovereignAuctionHouseV2(payable(f.createAuctionHouse()));
    }

    function _v21() internal view returns (SovereignAuctionHouseV2_1) {
        return SovereignAuctionHouseV2_1(payable(address(house)));
    }

    function _listMutable() internal returns (MutableERC721 bad, uint256 auctionId) {
        bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
    }

    /// @dev V2.1: a winner-only block settles at endAuction (nothing to
    ///      unwind); a collection that blocks every transfer defers, and the
    ///      refund branch still waits for the timeout.
    function test_UnwindStuckLotRevertsBeforeTimeout() public override {
        (MutableERC721 bad, uint256 auctionId) = _listMutable();
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.unwindStuckLot(auctionId);

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.expectRevert(SovereignAuctionHouseV2.UnwindTooEarly.selector);
        house.unwindStuckLot(auctionId);
    }

    /// @dev V2.1: the winner's address is blocked but the lot can move, so
    ///      the seller is paid at endAuction and the lot is held. The refund
    ///      and return of V2 now require a lot that cannot reach a fresh
    ///      address (here: the probe recipient is blocked too), and the
    ///      return to the seller then happens in the same call.
    function test_UnwindStuckLotRefundsWinnerAndReturnsLotToSeller() public override {
        (MutableERC721 bad, uint256 auctionId) = _listMutable();
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice, true);
        bad.setBlockedRecipient(_v21().DELIVERY_PROBE_RECIPIENT(), true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        uint256 sellerBefore = artist.balance;
        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotUnwound(auctionId, alice, RESERVE, artist);
        house.unwindStuckLot(auctionId);

        assertEq(bad.ownerOf(TOKEN_ID), artist, "the lot returns to the seller");
        assertEq(artist.balance, sellerBefore, "the seller is never paid ETH for this auction");
        assertEq(house.pendingRefunds(alice), RESERVE, "the winner's full bid is credited");
        assertFalse(house.pendingReturn(auctionId));
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, aliceBefore);
        assertEq(address(house).balance, 0);
    }

    /// @dev V2.1 version of the locked-return case: the collection blocks
    ///      every outbound transfer, so the winner is refunded after the
    ///      timeout and the lot stays locked until returnUnwoundLot.
    function test_UnwindStuckLotDefersReturnWhenSellerTransferAlsoFails() public override {
        (MutableERC721 bad, uint256 auctionId) = _listMutable();
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotReturnDeferred(auctionId, artist);
        house.unwindStuckLot(auctionId);

        assertTrue(house.pendingReturn(auctionId));
        assertEq(house.pendingRefunds(alice), RESERVE);
        assertEq(bad.ownerOf(TOKEN_ID), address(house));

        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC721(address(bad), TOKEN_ID, artist);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadySettled.selector);
        house.endAuction(auctionId);
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.unwindStuckLot(auctionId);

        bad.setTransferMode(false, false);
        vm.prank(bob);
        house.returnUnwoundLot(auctionId);
        assertEq(bad.ownerOf(TOKEN_ID), artist);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionDoesNotExist.selector);
        house.returnUnwoundLot(auctionId);

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, aliceBefore);
    }

    /// @dev V2.1 runs up to three capped calls (retry, probe, return), each
    ///      behind its own headroom guard. With a transfer that always costs
    ///      more than the stipend, a caller that can fund the retry and the
    ///      probe but not the return must revert, changing nothing.
    function test_UnwindStuckLotRevertsWhenGasBelowDoubleDeliveryHeadroom() public override {
        GasHungryERC721 heavy = new GasHungryERC721();
        heavy.mint(artist, TOKEN_ID);
        vm.prank(artist);
        heavy.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(heavy), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        heavy.setBurnIterations(40);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        (bool ok, bytes memory ret) =
            address(house).call{gas: 1_300_000}(abi.encodeWithSelector(house.unwindStuckLot.selector, auctionId));
        assertFalse(ok, "starved call must revert, not misclassify the return");
        assertEq(bytes4(ret), SovereignAuctionHouseV2.InsufficientGas.selector);
        assertTrue(house.pendingDelivery(auctionId), "no state change from the starved attempt");

        house.unwindStuckLot(auctionId);
        assertFalse(house.pendingDelivery(auctionId));
        assertTrue(house.pendingReturn(auctionId), "over-stipend return deferred to returnUnwoundLot");
        house.returnUnwoundLot(auctionId);
        assertEq(heavy.ownerOf(TOKEN_ID), artist);
    }
}

/// @dev Runs every Sovereign1155AuctionHouse test against a V2.1 house, with
///      the same by-design overrides as the ERC721 compat suite.
contract Sovereign1155AuctionHouseV2_1CompatTest is Sovereign1155AuctionHouseTest {
    function _newHouse(address owner) internal override returns (SovereignAuctionHouseV2) {
        SovereignAuctionHouseV2_1 impl = new SovereignAuctionHouseV2_1();
        SovereignAuctionHouseV2_1Factory f = new SovereignAuctionHouseV2_1Factory(address(impl), treasury, 250);
        vm.prank(owner);
        return SovereignAuctionHouseV2(payable(f.createAuctionHouse()));
    }

    function _v21() internal view returns (SovereignAuctionHouseV2_1) {
        return SovereignAuctionHouseV2_1(payable(address(house)));
    }

    function _fee() internal pure returns (uint256) {
        return (RESERVE * 250) / 10_000;
    }

    /// @dev V2.1: a bidder that gained code it cannot receive with still
    ///      binds its bid. The seller is paid; the lot is held, and the
    ///      winner can redirect it to an address that can receive.
    function test_ContractCodeOnBidderNoLongerBlocksSettlement() public override {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.etch(alice, hex"00");
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - _fee(), "the seller is paid at the hammer");
        assertTrue(_v21().heldForWinner(auctionId));
        assertFalse(house.pendingDelivery(auctionId));

        vm.prank(alice);
        house.claimLot(auctionId, carol);
        assertEq(token.balanceOf(carol, TOKEN_ID), QUANTITY);
    }

    /// @dev V2.1: the seller is paid when the auction ends, not when the
    ///      rejecting winner later redirects its claim.
    function test_RejectingContractWinnerIsDeferredThenClaimsToRedirect() public override {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        RejectingERC1155Bidder bidder = new RejectingERC1155Bidder();
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - _fee(), "the seller is paid at the hammer");
        assertTrue(_v21().heldForWinner(auctionId));
        assertEq(token.balanceOf(address(house), TOKEN_ID), QUANTITY);

        bidder.claim(address(house), auctionId, carol);
        assertEq(token.balanceOf(carol, TOKEN_ID), QUANTITY);
        assertFalse(_v21().heldForWinner(auctionId));
        assertEq(artist.balance - sellerBefore, RESERVE - _fee(), "no second payment on claim");
    }

    /// @dev V2.1 regression for audit finding 1: a winner that always rejects
    ///      delivery can no longer wait out the timeout for a refund. The
    ///      sale settled at endAuction; there is nothing to unwind.
    function test_UnwindStuckLotRefundsWinnerAndReturnsLotToSeller() public override {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        RejectingERC1155Bidder bidder = new RejectingERC1155Bidder();
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);
        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.unwindStuckLot(auctionId);

        assertEq(artist.balance - sellerBefore, RESERVE - _fee(), "the seller keeps the hammer price");
        assertEq(house.pendingRefunds(address(bidder)), 0, "no refund for a refusing winner");
        assertEq(token.balanceOf(address(house), TOKEN_ID), QUANTITY, "the lot stays held for the winner");
        assertEq(address(house).balance, 0);
    }

    /// @dev V2.1: a bare contract that wins pays for the lot. The lot stays
    ///      held for it indefinitely; it is never refunded and the token id
    ///      stays locked to that auction in this house.
    function test_BareContractGriefingResolvedByUnwind() public override {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        BareERC1155Bidder griefer = new BareERC1155Bidder();
        griefer.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - _fee(), "the seller is paid");
        assertTrue(_v21().heldForWinner(auctionId));

        vm.expectRevert();
        house.claimLot(auctionId, address(0));
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.unwindStuckLot(auctionId);
        assertEq(house.pendingRefunds(address(griefer)), 0);

        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
    }

    /// @dev V2.1: a winner hook that burns its whole stipend leaves too
    ///      little for the probe on a starved call; endAuction must revert
    ///      InsufficientGas rather than classify the lot as stuck.
    function test_UnwindStuckLotRevertsWhenGasBelowDoubleDeliveryHeadroom() public override {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        GasBurningBidder burner = new GasBurningBidder();
        burner.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        (bool ok, bytes memory ret) =
            address(house).call{gas: 900_000}(abi.encodeWithSelector(house.endAuction.selector, auctionId));
        assertFalse(ok, "starved call must revert, not misclassify the lot");
        assertEq(bytes4(ret), SovereignAuctionHouseV2.InsufficientGas.selector);
        assertFalse(house.pendingDelivery(auctionId));
        assertFalse(_v21().heldForWinner(auctionId));

        house.endAuction(auctionId);
        assertTrue(_v21().heldForWinner(auctionId));
    }
}
