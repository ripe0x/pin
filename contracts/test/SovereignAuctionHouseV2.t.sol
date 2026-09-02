// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {MockERC721} from "./MockERC721.sol";
import {PausableNFT} from "./PausableNFT.sol";

/// @dev Behaves normally for escrow, then can fail or no-op only on delivery.
contract MutableERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => mapping(address => bool)) internal _approvedForAll;
    bool public revertOutbound;
    bool public noopOutbound;
    address public blockedRecipient;

    function mint(address to, uint256 tokenId) external {
        _ownerOf[tokenId] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approvedForAll[msg.sender][operator] = approved;
    }

    function setTransferMode(bool shouldRevert, bool shouldNoop) external {
        revertOutbound = shouldRevert;
        noopOutbound = shouldNoop;
    }

    /// @dev Blocks outbound delivery to one address only, so a genuinely
    ///      undeliverable-to-winner case can still deliver to a different
    ///      recipient (the seller fallback in reclaimStuckLot).
    function setBlockedRecipient(address recipient) external {
        blockedRecipient = recipient;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _ownerOf[tokenId];
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _approvedForAll[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "wrong owner");
        require(msg.sender == from || _approvedForAll[from][msg.sender], "not approved");
        // Inbound escrow is operator-driven; outbound delivery is the house
        // moving its own balance, which lets this mock change behavior only
        // after a valid listing.
        if (revertOutbound && msg.sender == from) revert("delivery blocked");
        if (blockedRecipient != address(0) && to == blockedRecipient && msg.sender == from) {
            revert("recipient blocked");
        }
        if (noopOutbound && msg.sender == from) return;
        _ownerOf[tokenId] = to;
    }
}

/// @dev Escrow works normally. Delivery consumes a moderate, configurable
///      amount of gas (well under DELIVER_GAS_LIMIT) but always succeeds,
///      to show endAuction's outcome does not depend on caller-supplied gas.
contract GasHungryERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => mapping(address => bool)) internal _approvedForAll;
    mapping(uint256 => uint256) internal _burnStorage;
    uint256 public burnIterations = 10;

    function mint(address to, uint256 tokenId) external {
        _ownerOf[tokenId] = to;
    }

    function setBurnIterations(uint256 n) external {
        burnIterations = n;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approvedForAll[msg.sender][operator] = approved;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _ownerOf[tokenId];
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _approvedForAll[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "wrong owner");
        require(msg.sender == from || _approvedForAll[from][msg.sender], "not approved");
        if (msg.sender == from) {
            for (uint256 i = 0; i < burnIterations; i++) {
                _burnStorage[i] = i + 1;
            }
        }
        _ownerOf[tokenId] = to;
    }
}

/// @dev Models a seller-controlled ERC721 collection with a backdoor: any
///      account the seller designates as `admin` can force a transfer
///      regardless of approval. A normal collection has no such function;
///      this exists to prove the funds-before-delivery reorder in endAuction
///      closes the payout-callback clawback (CWE-367) found in the audit.
contract ClawbackERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => mapping(address => bool)) internal _approvedForAll;
    address public admin;

    function mint(address to, uint256 tokenId) external {
        _ownerOf[tokenId] = to;
    }

    function setAdmin(address admin_) external {
        admin = admin_;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approvedForAll[msg.sender][operator] = approved;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _ownerOf[tokenId];
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _approvedForAll[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "wrong owner");
        require(msg.sender == from || _approvedForAll[from][msg.sender], "not approved");
        _ownerOf[tokenId] = to;
    }

    /// @dev The backdoor: admin-only, bypasses approval. Still requires
    ///      `from` to currently hold the token, so it can only claw the lot
    ///      back once delivery has actually moved it to the winner.
    function forceTransfer(address from, address to, uint256 tokenId) external {
        require(msg.sender == admin, "not admin");
        require(_ownerOf[tokenId] == from, "wrong owner");
        _ownerOf[tokenId] = to;
    }
}

/// @dev fundsRecipient for the seller running the clawback in
///      ClawbackERC721: its receive() callback fires during the settlement
///      payout and attempts to force the lot from the winner back to the
///      auction house.
contract ClawbackRecipient {
    ClawbackERC721 public nft;
    address public house;
    uint256 public tokenId;
    address public winner;
    bool public attempted;
    bool public succeeded;

    function configure(ClawbackERC721 nft_, address house_, uint256 tokenId_, address winner_) external {
        nft = nft_;
        house = house_;
        tokenId = tokenId_;
        winner = winner_;
    }

    receive() external payable {
        attempted = true;
        try nft.forceTransfer(winner, house, tokenId) {
            succeeded = true;
        } catch {}
    }
}

contract SovereignAuctionHouseV2Test is Test {
    SovereignAuctionHouseV2 internal house;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA01);
    address internal creator = address(0xC0FFEE);
    address payable internal treasury = payable(address(0xFEE));

    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant RESERVE = 1 ether;
    uint256 internal constant DURATION = 24 hours;

    function setUp() public {
        nft = new MockERC721();
        nft.mint(artist, TOKEN_ID);
        SovereignAuctionHouseV2 impl = new SovereignAuctionHouseV2();
        SovereignAuctionHouseV2Factory factory = new SovereignAuctionHouseV2Factory(address(impl), treasury, 250);
        vm.prank(artist);
        house = SovereignAuctionHouseV2(payable(factory.createAuctionHouse()));
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _create() internal returns (uint256) {
        vm.prank(artist);
        return house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE, 0);
    }

    function _bidAndEnd(uint256 auctionId, address bidder, uint256 amount) internal {
        vm.prank(bidder);
        house.createBid{value: amount}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);
    }

    function test_VerifiedDeliveryPaysFundsRecipient() public {
        uint256 auctionId = _create();
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(carol));
        _bidAndEnd(auctionId, alice, RESERVE);

        uint256 treasuryBefore = treasury.balance;
        uint256 carolBefore = carol.balance;
        house.endAuction(auctionId);

        uint256 fee = (RESERVE * 250) / 10_000;
        assertEq(nft.ownerOf(TOKEN_ID), alice);
        assertEq(treasury.balance - treasuryBefore, fee);
        assertEq(carol.balance - carolBefore, RESERVE - fee);
        (bool exists,) = house.getAuctionFor(address(nft), TOKEN_ID);
        assertFalse(exists);
        assertFalse(house.pendingDelivery(auctionId));
    }

    function test_FundsRecipientCanOnlyChangeByTokenOwnerBeforeBid() public {
        uint256 auctionId = _create();
        vm.expectRevert("Not token owner");
        vm.prank(bob);
        house.setAuctionFundsRecipient(auctionId, payable(bob));
        vm.expectRevert(SovereignAuctionHouseV2.FundsRecipientRequired.selector);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(address(0)));
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(carol));
    }

    function test_CustomDurationCanChangeOnlyBeforeBid() public {
        uint256 auctionId = _create();
        vm.prank(artist);
        house.setAuctionDuration(auctionId, 2 hours);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionId);
        assertEq(a.duration, 2 hours);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.setAuctionDuration(auctionId, 3 hours);
    }

    function test_ExpiredNoBidListingRejectsBidsAndAnyoneCanClearIt() public {
        uint256 auctionId = _create();
        vm.prank(artist);
        house.setAuctionListingExpiry(auctionId, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);

        vm.expectRevert(SovereignAuctionHouseV2.AuctionExpired.selector);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);

        vm.prank(bob);
        house.expireAuction(auctionId);
        assertEq(nft.ownerOf(TOKEN_ID), artist);
        (bool exists,) = house.getAuctionFor(address(nft), TOKEN_ID);
        assertFalse(exists);
    }

    function test_StandardContractBidderStillReceivesPlainTransfer() public {
        uint256 auctionId = _create();
        _bidAndEnd(auctionId, alice, RESERVE);
        house.endAuction(auctionId);
        assertEq(nft.ownerOf(TOKEN_ID), alice);
    }

    /// @dev A collection that reverts delivery pays the seller in full at
    ///      endAuction and defers the lot; the winner claims once delivery
    ///      is possible again.
    function test_RevertingDeliveryDefersLotButSellerIsPaidInFull() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;

        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2.DeliveryDeferred(auctionId, alice);
        house.endAuction(auctionId);

        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(bad.ownerOf(TOKEN_ID), address(house));

        // The lot still blocks a duplicate listing and stuck-token recovery.
        (bool active,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertTrue(active);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC721(address(bad), TOKEN_ID, artist);

        // Re-entering endAuction on a deferred auction is rejected.
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadySettled.selector);
        house.endAuction(auctionId);

        // claimLot while still broken reverts (no ETH movement, retryable).
        bad.setTransferMode(true, false);
        vm.expectRevert("delivery blocked");
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        // A third party may not redirect delivery away from the winner.
        bad.setTransferMode(false, false);
        vm.expectRevert(SovereignAuctionHouseV2.NotWinner.selector);
        vm.prank(bob);
        house.claimLot(auctionId, carol);

        // But a third party may permissionlessly trigger delivery to the
        // recorded winner once delivery works again.
        vm.prank(bob);
        house.claimLot(auctionId, address(0));
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
        (bool activeAfter,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(activeAfter);

        // Double claim reverts.
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
    }

    /// @dev CWE-362 (documented best-effort, no logic change): anyone may
    ///      trigger delivery to the recorded winner once delivery is possible
    ///      again; only the winner may redirect it elsewhere. A third party
    ///      claiming to the winner first permanently forecloses the winner's
    ///      own redirect, since the pending state is consumed by whichever
    ///      call succeeds first. The token still always reaches the winner's
    ///      own bid address.
    function test_ThirdPartyCanTriggerClaimToWinnerButNotRedirect() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));
        bad.setTransferMode(false, false);

        // A third party redirecting to itself reverts.
        vm.expectRevert(SovereignAuctionHouseV2.NotWinner.selector);
        vm.prank(bob);
        house.claimLot(auctionId, bob);

        // A third party triggering delivery to the winner succeeds; the
        // token lands with the winner, not the caller.
        vm.prank(bob);
        house.claimLot(auctionId, address(0));
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
    }

    /// @dev The winner's own redirect via a nonzero `to` is unaffected by the
    ///      permissionless-to-winner change.
    function test_WinnerCanStillRedirectOwnClaim() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        bad.setTransferMode(false, false);

        vm.prank(alice);
        house.claimLot(auctionId, carol);
        assertEq(bad.ownerOf(TOKEN_ID), carol);
    }

    /// @dev CWE-841 fix: a deferred lot's delivery failure can be temporary
    ///      (here, the collection un-breaks before the timeout). reclaimStuckLot
    ///      retries delivery to the recorded winner first, so a since-fixed
    ///      collection sends the lot to the winner, not the seller, even
    ///      after PENDING_DELIVERY_TIMEOUT has passed. Reclaiming is blocked
    ///      before the timeout, for a non-tokenOwner caller, for a live
    ///      (non-deferred) auction, and after the lot is already gone.
    function test_ReclaimStuckLotRetriesWinnerDeliveryBeforeSellerFallback() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);

        // A live, non-deferred auction cannot be reclaimed.
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.reclaimStuckLot(auctionId);

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), uint64(block.timestamp));

        // Too early.
        vm.expectRevert(SovereignAuctionHouseV2.ReclaimTooEarly.selector);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        // The collection un-breaks before the timeout elapses, but no one
        // claims within the window.
        bad.setTransferMode(false, false);
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        // Not the tokenOwner.
        vm.expectRevert("Not token owner");
        vm.prank(bob);
        house.reclaimStuckLot(auctionId);

        vm.expectEmit(true, true, true, false, address(house));
        emit ISovereignAuctionHouseV2.LotClaimed(auctionId, alice, alice);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        // The winner received the lot, not the seller.
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), 0);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        // Double reclaim reverts: the auction no longer exists.
        vm.expectRevert(SovereignAuctionHouseV2.AuctionDoesNotExist.selector);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        // Relisting the same tokenId now works. The house owner (artist) is
        // the only account that can call createAuction; its new owner
        // (alice) authorizes the listing by approving artist as consignor
        // and the house to pull the escrow transfer.
        vm.prank(alice);
        bad.setApprovalForAll(artist, true);
        vm.prank(alice);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
    }

    /// @dev When delivery to the winner still genuinely fails at reclaim
    ///      time (here, the collection blocks that specific recipient),
    ///      reclaimStuckLot falls back to the seller exactly as before the
    ///      CWE-841 fix.
    function test_ReclaimStuckLotFallsBackToSellerWhenWinnerDeliveryStillFails() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2.LotReclaimed(auctionId, artist);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        // The seller got the lot; the winner (still blocked) never did, so
        // there is no state where both hold it.
        assertEq(bad.ownerOf(TOKEN_ID), artist);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), 0);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");
    }

    /// @dev Once claimLot delivers a deferred lot, reclaimStuckLot can no
    ///      longer act on it: the auction record is gone.
    function test_ReclaimStuckLotAfterClaimLotRevertsAuctionGone() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        bad.setTransferMode(false, false);

        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionDoesNotExist.selector);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);
    }

    /// @dev A normal, immediately-delivered settlement never sets
    ///      deliveryDeferredAt, so a later reclaim attempt is impossible.
    function test_HappyPathSettlementLeavesNoDeferralTimestamp() public {
        uint256 auctionId = _create();
        _bidAndEnd(auctionId, alice, RESERVE);
        house.endAuction(auctionId);
        assertEq(house.deliveryDeferredAt(auctionId), 0);
        assertFalse(house.pendingDelivery(auctionId));
    }

    function test_SilentOutboundNoopDefersDeliveryAndPaysSeller() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(false, true);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(bad.ownerOf(TOKEN_ID), address(house));

        bad.setTransferMode(false, false);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(bad.ownerOf(TOKEN_ID), alice);
    }

    /// @dev claimLot's `to` argument redirects delivery away from the
    ///      winner's own address; only the recorded winner may call it.
    function test_ClaimLotRedirectsDeliveryToChosenAddress() public {
        PausableNFT paused = new PausableNFT();
        paused.mint(artist, TOKEN_ID);
        vm.prank(artist);
        paused.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(paused), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        paused.pause();
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));

        // Claim reverts while the collection is still paused.
        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        paused.unpause();
        vm.prank(alice);
        house.claimLot(auctionId, carol);
        assertEq(paused.ownerOf(TOKEN_ID), carol);
    }

    /// @dev A burned escrowed token can never be delivered. The seller is
    ///      still paid in full at endAuction and no ETH is stranded in the
    ///      house; claimLot always reverts thereafter.
    function test_BurnedEscrowedTokenStillPaysSellerAndNeverStrandsEth() public {
        PausableNFT burnable = new PausableNFT();
        burnable.mint(artist, TOKEN_ID);
        vm.prank(artist);
        burnable.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(burnable), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        burnable.burn(TOKEN_ID);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(address(house).balance, 0);

        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
    }

    /// @dev The fixed DELIVER_GAS_LIMIT stipend means delivery either always
    ///      succeeds or always fails for a given collection's transfer cost,
    ///      regardless of how much extra gas the endAuction caller supplies.
    function test_DeliveryOutcomeDoesNotDependOnCallerSuppliedGas() public {
        GasHungryERC721 tokenA = new GasHungryERC721();
        tokenA.mint(artist, TOKEN_ID);
        vm.prank(artist);
        tokenA.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionIdGenerous = house.createAuction(TOKEN_ID, address(tokenA), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionIdGenerous);
        vm.warp(block.timestamp + DURATION + 1);

        (bool okGenerous,) =
            address(house).call{gas: 5_000_000}(abi.encodeWithSelector(house.endAuction.selector, auctionIdGenerous));
        assertTrue(okGenerous);
        assertFalse(house.pendingDelivery(auctionIdGenerous));
        assertEq(tokenA.ownerOf(TOKEN_ID), alice);

        GasHungryERC721 tokenB = new GasHungryERC721();
        tokenB.mint(artist, TOKEN_ID + 1);
        vm.prank(artist);
        tokenB.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionIdTight = house.createAuction(TOKEN_ID + 1, address(tokenB), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionIdTight);
        vm.warp(block.timestamp + DURATION + 1);

        (bool okTight,) =
            address(house).call{gas: 700_000}(abi.encodeWithSelector(house.endAuction.selector, auctionIdTight));
        assertTrue(okTight);
        assertFalse(house.pendingDelivery(auctionIdTight));
        assertEq(tokenB.ownerOf(TOKEN_ID + 1), alice);
    }

    /// @dev A delivery that costs more than DELIVER_GAS_LIMIT is deferred no
    ///      matter how much gas the endAuction caller supplies, and claimLot,
    ///      which runs with full gas, then completes it.
    function test_DeliveryAboveStipendIsDeferredThenClaimLotSucceedsWithFullGas() public {
        GasHungryERC721 token = new GasHungryERC721();
        token.mint(artist, TOKEN_ID);
        vm.prank(artist);
        token.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(token), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        // 40 fresh SSTOREs at ~22k each is well over the 500k stipend.
        token.setBurnIterations(40);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        (bool ok,) =
            address(house).call{gas: 5_000_000}(abi.encodeWithSelector(house.endAuction.selector, auctionId));
        assertTrue(ok, "endAuction itself must not revert");
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId), "over-stipend delivery is deferred");
        assertEq(token.ownerOf(TOKEN_ID), address(house));

        vm.prank(bob);
        house.claimLot(auctionId, address(0));
        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
    }

    /// @dev Below the headroom guard, endAuction must revert InsufficientGas
    ///      rather than misclassify a good delivery as deferred.
    function test_EndAuctionRevertsWhenGasBelowDeliveryHeadroom() public {
        GasHungryERC721 token = new GasHungryERC721();
        token.mint(artist, TOKEN_ID);
        vm.prank(artist);
        token.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(token), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        (bool ok,) =
            address(house).call{gas: 520_000}(abi.encodeWithSelector(house.endAuction.selector, auctionId));
        assertFalse(ok, "starved call must revert, not defer");
        assertFalse(house.pendingDelivery(auctionId), "no deferral recorded");
        assertEq(token.ownerOf(TOKEN_ID), address(house), "lot still escrowed");

        house.endAuction(auctionId);
        assertEq(token.ownerOf(TOKEN_ID), alice, "settles normally with full gas");
    }

    /// @dev The consigned artist (tokenOwner, not the house owner) can still
    ///      cancel pre-bid and get the token back.
    function test_ConsignedArtistCancelsPreBidAndRegainsToken() public {
        uint256 tokenId = TOKEN_ID + 300;
        nft.mint(creator, tokenId);
        vm.prank(creator);
        nft.setApprovalForAll(artist, true);
        vm.prank(creator);
        nft.setApprovalForAll(address(house), true);

        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenId, address(nft), DURATION, RESERVE, 0);

        vm.prank(creator);
        house.cancelAuction(auctionId);
        assertEq(nft.ownerOf(tokenId), creator);
    }

    function _consign(uint256 tokenId, uint64 listingExpiry_) internal returns (uint256) {
        nft.mint(creator, tokenId);
        vm.prank(creator);
        nft.setApprovalForAll(artist, true);
        vm.prank(creator);
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        return house.createAuction(tokenId, address(nft), DURATION, RESERVE, listingExpiry_);
    }

    /// @dev A creator-set listing expiry is stored, appears in AuctionCreated,
    ///      rejects bids once passed, and lets anyone clear the listing back
    ///      to the consigned token owner.
    function test_CreateWithFutureListingExpiryStoresEmitsAndExpires() public {
        uint256 tokenId = TOKEN_ID + 600;
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 expectedId = house.nextAuctionId();

        nft.mint(creator, tokenId);
        vm.prank(creator);
        nft.setApprovalForAll(artist, true);
        vm.prank(creator);
        nft.setApprovalForAll(address(house), true);

        vm.expectEmit(true, true, true, true, address(house));
        emit ISovereignAuctionHouseV2.AuctionCreated(
            expectedId, tokenId, address(nft), DURATION, RESERVE, creator, creator, expiry
        );
        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenId, address(nft), DURATION, RESERVE, expiry);

        assertEq(house.listingExpiry(auctionId), expiry);

        vm.warp(expiry);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionExpired.selector);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);

        vm.prank(bob);
        house.expireAuction(auctionId);
        assertEq(nft.ownerOf(tokenId), creator);
        (bool exists,) = house.getAuctionFor(address(nft), tokenId);
        assertFalse(exists);
    }

    /// @dev A non-future listing expiry reverts at create; zero is accepted
    ///      and leaves the listing open.
    function test_CreateListingExpiryPastRevertsZeroAccepted() public {
        uint256 tokenIdPast = TOKEN_ID + 601;
        nft.mint(artist, tokenIdPast);
        vm.expectRevert("expiry must be future");
        vm.prank(artist);
        house.createAuction(tokenIdPast, address(nft), DURATION, RESERVE, uint64(block.timestamp));

        uint256 tokenIdZero = TOKEN_ID + 602;
        nft.mint(artist, tokenIdZero);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenIdZero, address(nft), DURATION, RESERVE, 0);
        assertEq(house.listingExpiry(auctionId), 0);
    }

    /// @dev A bid placed before the listing expiry starts the normal auction
    ///      clock; the expiry stops applying and expireAuction reverts once
    ///      firstBidTime is set, regardless of the wall clock.
    function test_BidBeforeDeadlineIgnoresExpiryAndBlocksLateExpire() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE, expiry);

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);

        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionNotEnded.selector);
        house.expireAuction(auctionId);

        house.endAuction(auctionId);
        assertEq(nft.ownerOf(TOKEN_ID), alice);
    }

    /// @dev The consigned token owner can change or clear the creator-set
    ///      expiry pre-bid; the house owner cannot.
    function test_TokenOwnerOverridesCreatorSetExpiryHouseOwnerCannot() public {
        uint256 tokenId = TOKEN_ID + 603;
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 auctionId = _consign(tokenId, expiry);
        assertEq(house.listingExpiry(auctionId), expiry);

        vm.expectRevert("Not token owner");
        vm.prank(artist);
        house.setAuctionListingExpiry(auctionId, uint64(block.timestamp + 2 hours));

        uint64 newExpiry = uint64(block.timestamp + 3 hours);
        vm.prank(creator);
        house.setAuctionListingExpiry(auctionId, newExpiry);
        assertEq(house.listingExpiry(auctionId), newExpiry);

        vm.prank(creator);
        house.setAuctionListingExpiry(auctionId, 0);
        assertEq(house.listingExpiry(auctionId), 0);
    }

    /// @dev bulkCreateAuctions applies the same listingExpiry_ to every lot
    ///      in the batch.
    function test_BulkCreateAuctionsAppliesListingExpiryToEveryLot() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = TOKEN_ID + 700;
        ids[1] = TOKEN_ID + 701;
        for (uint256 i; i < ids.length; ++i) {
            nft.mint(artist, ids[i]);
        }
        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.prank(artist);
        uint256[] memory auctionIds = house.bulkCreateAuctions(address(nft), ids, RESERVE, DURATION, expiry);

        for (uint256 i; i < auctionIds.length; ++i) {
            assertEq(house.listingExpiry(auctionIds[i]), expiry);
        }
    }

    /// @dev Audit High (CWE-367): a seller-controlled collection could use
    ///      its fundsRecipient's payout-receive callback to claw the lot
    ///      back from the winner after delivery but before cleanup, leaving
    ///      the house holding an unlocked token the owner could then drain
    ///      via recoverStuckERC721 while the seller kept the proceeds.
    ///      endAuction now settles funds before attempting delivery, so the
    ///      callback fires while the token is still escrowed: the backdoor's
    ///      `from == winner` check fails and the clawback cannot succeed,
    ///      and delivery runs afterward with no further external call able
    ///      to reverse it.
    function test_FundsBeforeDeliveryClosesPayoutCallbackClawback() public {
        ClawbackERC721 bad = new ClawbackERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);

        ClawbackRecipient recipient = new ClawbackRecipient();
        bad.setAdmin(address(recipient));
        recipient.configure(bad, address(house), TOKEN_ID, alice);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(address(recipient)));

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(auctionId);

        // The payout callback ran, but the clawback attempt failed: the
        // token had not moved to the winner yet at that point.
        assertTrue(recipient.attempted());
        assertFalse(recipient.succeeded());

        // Delivery completed normally as the last step, and cleanup is
        // consistent with that outcome.
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists);

        // The must-hold invariant: there is no reachable state where the
        // house holds the lot while the reverse index is cleared for it.
        bool houseHoldsLot = bad.ownerOf(TOKEN_ID) == address(house);
        assertFalse(houseHoldsLot && !exists, "house holds an unlocked lot");

        // The owner cannot pull the lot out through stuck-token recovery
        // (the winner already owns it, so there is nothing to recover).
        vm.expectRevert();
        vm.prank(artist);
        house.recoverStuckERC721(address(bad), TOKEN_ID, artist);
    }
}
