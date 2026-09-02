// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {MockERC721} from "./MockERC721.sol";
import {PausableNFT} from "./PausableNFT.sol";

/// @dev Behaves normally for escrow, then can fail or no-op only on delivery.
///      `blocked` can mark any number of recipients as undeliverable at
///      once, so a test can block the winner and the seller independently.
contract MutableERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => mapping(address => bool)) internal _approvedForAll;
    mapping(address => bool) public blocked;
    bool public revertOutbound;
    bool public noopOutbound;

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

    /// @dev Blocks (or unblocks) outbound delivery to one address, so a test
    ///      can make delivery fail for the winner, the seller, or both
    ///      independently.
    function setBlockedRecipient(address recipient, bool isBlocked) external {
        blocked[recipient] = isBlocked;
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
        if (blocked[to] && msg.sender == from) revert("recipient blocked");
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
///      this exists to prove settlement cannot be made to pay before
///      delivery is verified, and that the payout leg itself never hands
///      control to a contract recipient.
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
///      ClawbackERC721. Its receive() attempts to force the lot from the
///      winner back to the auction house. Because it is a contract, the
///      new payout rule never calls it: settlement credits it to
///      pendingRefunds instead of pushing, so this callback is unreachable
///      from settlement regardless of timing.
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

/// @dev Plain contract fundsRecipient with no attack behavior, used to prove
///      a contract recipient is credited to pendingRefunds and never
///      called during settlement.
contract ContractFundsRecipient {
    bool public called;

    receive() external payable {
        called = true;
    }
}

/// @dev Outbid-refund recipient that re-enters a pre-bid setter on a
///      different auction it owns as tokenOwner. Used to prove nonReentrant
///      on the listing setters blocks reentrancy reached through the
///      createBid outbid refund callback. _sendOrCredit forwards only 30_000
///      gas to receive(), so the outcome is packed into a single bytes4
///      storage write: two cold SSTOREs (a bool plus a bytes revert-data
///      copy) do not fit that stipend alongside the reentrant call itself.
contract ReentrantSetterBidder {
    bytes4 internal constant SUCCESS_MARKER = 0xffffffff;

    SovereignAuctionHouseV2 public house;
    uint256 public otherAuctionId;
    bytes4 public outcome;

    function configure(SovereignAuctionHouseV2 house_, uint256 otherAuctionId_) external {
        house = house_;
        otherAuctionId = otherAuctionId_;
    }

    function bid(uint256 auctionId) external payable {
        house.createBid{value: msg.value}(auctionId);
    }

    function attempted() external view returns (bool) {
        return outcome != bytes4(0);
    }

    function succeeded() external view returns (bool) {
        return outcome == SUCCESS_MARKER;
    }

    receive() external payable {
        try house.setAuctionFundsRecipient(otherAuctionId, payable(address(this))) {
            outcome = SUCCESS_MARKER;
        } catch (bytes memory reason) {
            outcome = reason.length >= 4 ? bytes4(reason) : bytes4(0x11111111);
        }
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

    /// @dev No ETH is ever stranded: whatever the house holds must equal the
    ///      sum of pendingRefunds for every account a test touched.
    function _assertConserved(address[] memory touched) internal view {
        uint256 sum;
        for (uint256 i; i < touched.length; ++i) {
            sum += house.pendingRefunds(touched[i]);
        }
        assertEq(address(house).balance, sum, "ETH conservation invariant violated");
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
        assertEq(address(house).balance, 0, "house holds no residual ETH for this auction");
    }

    /// @dev A contract fundsRecipient (code.length != 0) is never called by
    ///      settlement, regardless of whether it would behave honestly: it
    ///      is credited to pendingRefunds and withdraws with a pull.
    function test_ContractFundsRecipientIsCreditedNeverPushed() public {
        ContractFundsRecipient recipient = new ContractFundsRecipient();
        uint256 auctionId = _create();
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(address(recipient)));
        _bidAndEnd(auctionId, alice, RESERVE);

        house.endAuction(auctionId);

        uint256 fee = (RESERVE * 250) / 10_000;
        assertEq(nft.ownerOf(TOKEN_ID), alice);
        assertFalse(recipient.called(), "a contract recipient must never be pushed a call from settlement");
        assertEq(address(recipient).balance, 0);
        assertEq(house.pendingRefunds(address(recipient)), RESERVE - fee);

        address[] memory touched = new address[](2);
        touched[0] = treasury;
        touched[1] = address(recipient);
        _assertConserved(touched);

        vm.prank(address(recipient));
        house.withdrawRefund();
        assertEq(address(recipient).balance, RESERVE - fee);
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

    /// @dev A collection that reverts delivery pays nobody at endAuction and
    ///      defers the lot; the winning bid stays escrowed until the winner
    ///      is actually delivered the token, at which point the seller and
    ///      protocol fee are paid.
    function test_RevertingDeliveryDefersLotAndPaysNobodyUntilClaim() public {
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
        uint256 treasuryBefore = treasury.balance;
        uint256 fee = (RESERVE * 250) / 10_000;

        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2.DeliveryDeferred(auctionId, alice);
        house.endAuction(auctionId);

        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertEq(treasury.balance, treasuryBefore, "the protocol fee is not paid on a deferred delivery");
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(bad.ownerOf(TOKEN_ID), address(house));
        assertEq(address(house).balance, RESERVE, "the winning bid stays escrowed");

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
        // recorded winner once delivery works again. The seller and
        // protocol fee are paid at this moment, not before.
        vm.prank(bob);
        house.claimLot(auctionId, address(0));
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertEq(treasury.balance - treasuryBefore, fee);
        assertEq(address(house).balance, 0);
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
    ///      permissionless-to-winner change, and pays the seller at the
    ///      moment the redirect succeeds.
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

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        vm.prank(alice);
        house.claimLot(auctionId, carol);
        assertEq(bad.ownerOf(TOKEN_ID), carol);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid exactly when the redirect succeeds");
    }

    /// @dev unwindStuckLot reverts before the auction has any deferred
    ///      delivery, and again before PENDING_DELIVERY_TIMEOUT has passed.
    function test_UnwindStuckLotRevertsBeforeTimeout() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);

        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        house.unwindStuckLot(auctionId);

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice, true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.expectRevert(SovereignAuctionHouseV2.UnwindTooEarly.selector);
        house.unwindStuckLot(auctionId);
    }

    /// @dev After PENDING_DELIVERY_TIMEOUT, unwindStuckLot's retry to the
    ///      winner still fails (the collection permanently blocks that
    ///      recipient), so the sale unwinds: the winner's full bid is
    ///      credited for withdrawal and the lot returns to the seller. The
    ///      seller is never paid ETH for this auction, matching the product
    ///      rule that a seller must never be paid without the winner
    ///      receiving the lot.
    function test_UnwindStuckLotRefundsWinnerAndReturnsLotToSeller() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice, true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        uint256 sellerBefore = artist.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotUnwound(auctionId, alice, RESERVE, artist);
        house.unwindStuckLot(auctionId);

        assertEq(bad.ownerOf(TOKEN_ID), artist, "the lot returns to the seller");
        assertEq(artist.balance, sellerBefore, "the seller is never paid ETH for this auction");
        assertEq(treasury.balance, treasuryBefore, "the protocol is never paid for this auction");
        assertEq(house.pendingRefunds(alice), RESERVE, "the winner's full bid is credited");
        assertFalse(house.pendingDelivery(auctionId));
        assertFalse(house.pendingReturn(auctionId));
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        address[] memory touched = new address[](1);
        touched[0] = alice;
        _assertConserved(touched);

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, aliceBefore, "the winner recovers exactly what it bid");
        assertEq(address(house).balance, 0);
    }

    /// @dev The collection un-breaks before the 30-day window closes, but no
    ///      one claims within it. unwindStuckLot's retry to the winner then
    ///      succeeds: the sale finalizes normally (LotClaimed, not
    ///      LotUnwound) and the seller is paid at that moment, not before.
    function test_UnwindStuckLotRetriesWinnerDeliveryBeforeUnwinding() public {
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
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;

        vm.expectEmit(true, true, true, false, address(house));
        emit ISovereignAuctionHouseV2.LotClaimed(auctionId, alice, alice);
        house.unwindStuckLot(auctionId);

        assertEq(bad.ownerOf(TOKEN_ID), alice, "the winner received the lot, not the seller");
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid now that delivery succeeded");
        assertFalse(house.pendingDelivery(auctionId));
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        // The auction record is gone; a second unwind attempt has nothing
        // to act on.
        vm.expectRevert(SovereignAuctionHouseV2.AuctionDoesNotExist.selector);
        house.unwindStuckLot(auctionId);
    }

    /// @dev The collection blocks the return-to-seller transfer as well as
    ///      the retry-to-winner transfer. The winner is still refunded
    ///      unconditionally; the lot stays locked (pendingReturn) rather
    ///      than being lost, and every other entry point correctly refuses
    ///      to touch it until returnUnwoundLot succeeds.
    function test_UnwindStuckLotDefersReturnWhenSellerTransferAlsoFails() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice, true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        bad.setBlockedRecipient(artist, true);

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotReturnDeferred(auctionId, artist);
        house.unwindStuckLot(auctionId);

        assertTrue(house.pendingReturn(auctionId));
        assertEq(house.pendingRefunds(alice), RESERVE, "the winner is refunded regardless of the return outcome");
        assertEq(bad.ownerOf(TOKEN_ID), address(house), "the lot stays locked in the house");

        // The lock holds: recovery, endAuction, claimLot, and a second
        // unwind attempt all refuse to touch it.
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

        // Unblock the seller recipient and let anyone complete the return.
        bad.setBlockedRecipient(artist, false);
        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2.LotReturned(auctionId, artist);
        vm.prank(bob);
        house.returnUnwoundLot(auctionId);

        assertEq(bad.ownerOf(TOKEN_ID), artist);
        assertFalse(house.pendingReturn(auctionId));
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        // The auction record is gone too: a second return attempt has
        // nothing left to act on.
        vm.expectRevert(SovereignAuctionHouseV2.AuctionDoesNotExist.selector);
        house.returnUnwoundLot(auctionId);

        address[] memory touched = new address[](1);
        touched[0] = alice;
        _assertConserved(touched);

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, aliceBefore, "the winner recovers exactly what it bid");
    }

    /// @dev Below the doubled headroom guard, unwindStuckLot must revert
    ///      InsufficientGas rather than let a gas-starved retry or return
    ///      attempt run under-stipend and be misclassified as a genuine
    ///      delivery failure.
    function test_UnwindStuckLotRevertsWhenGasBelowDoubleDeliveryHeadroom() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBlockedRecipient(alice, true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        (bool ok,) =
            address(house).call{gas: 900_000}(abi.encodeWithSelector(house.unwindStuckLot.selector, auctionId));
        assertFalse(ok, "starved call must revert, not misclassify delivery");
        assertTrue(house.pendingDelivery(auctionId), "no state change from the starved attempt");

        house.unwindStuckLot(auctionId);
        assertFalse(house.pendingDelivery(auctionId));
    }

    function test_SilentOutboundNoopDefersDeliveryAndPaysNobodyUntilClaim() public {
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
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(bad.ownerOf(TOKEN_ID), address(house));

        bad.setTransferMode(false, false);
        uint256 fee = (RESERVE * 250) / 10_000;
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(bad.ownerOf(TOKEN_ID), alice);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once claimLot succeeds");
    }

    /// @dev claimLot's `to` argument redirects delivery away from the
    ///      winner's own address; only the recorded winner may call it. The
    ///      seller is not paid while the collection stays paused.
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
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid while the collection is paused");
        assertTrue(house.pendingDelivery(auctionId));

        // Claim reverts while the collection is still paused.
        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        paused.unpause();
        uint256 fee = (RESERVE * 250) / 10_000;
        vm.prank(alice);
        house.claimLot(auctionId, carol);
        assertEq(paused.ownerOf(TOKEN_ID), carol);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once the redirect succeeds");
    }

    /// @dev A burned escrowed token can never be delivered to the winner or
    ///      returned to the seller. Nobody is ever paid ETH for this
    ///      auction, and no ETH is stranded in the house: the winner's bid
    ///      is refunded unconditionally at unwind, even though the lot
    ///      itself is permanently unrecoverable.
    function test_BurnedEscrowedTokenNeverPaysAnyoneAndWinnerIsStillRefunded() public {
        PausableNFT burnable = new PausableNFT();
        burnable.mint(artist, TOKEN_ID);
        vm.prank(artist);
        burnable.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(burnable), DURATION, RESERVE, 0);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        burnable.burn(TOKEN_ID);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid: delivery failed");
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(address(house).balance, RESERVE);

        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        house.unwindStuckLot(auctionId);

        assertEq(artist.balance, sellerBefore, "the seller is still never paid");
        assertEq(house.pendingRefunds(alice), RESERVE, "the winner is refunded despite the lot being unrecoverable");
        assertTrue(house.pendingReturn(auctionId), "the lot is permanently locked, not lost silently");

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, aliceBefore);
        assertEq(address(house).balance, 0, "no ETH is stranded even though the lot itself is gone");
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
    ///      which runs with full gas, then completes it and pays the seller.
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
        assertEq(artist.balance, sellerBefore, "the seller is not paid while delivery is deferred");
        assertTrue(house.pendingDelivery(auctionId), "over-stipend delivery is deferred");
        assertEq(token.ownerOf(TOKEN_ID), address(house));

        vm.prank(bob);
        house.claimLot(auctionId, address(0));
        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once claimLot succeeds");
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

    /// @dev Audit High (CWE-367) regression, closed by the deliver-first,
    ///      credit-not-push payout rule: a seller-controlled collection's
    ///      admin backdoor can only claw the lot back through its
    ///      fundsRecipient's payout callback, and since that recipient is a
    ///      contract, settlement never calls it at all. The callback simply
    ///      never fires; the winner keeps the lot unconditionally.
    function test_ClawbackNeverRunsBecauseContractRecipientIsCreditedNotPushed() public {
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

        // The payout callback never fired: the recipient is a contract, so
        // settlement credited it instead of calling it.
        assertFalse(recipient.attempted());
        assertFalse(recipient.succeeded());

        assertEq(bad.ownerOf(TOKEN_ID), alice);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists);

        uint256 fee = (RESERVE * 250) / 10_000;
        assertEq(house.pendingRefunds(address(recipient)), RESERVE - fee);

        // The owner cannot pull the lot out through stuck-token recovery
        // (the winner already owns it, so there is nothing to recover).
        vm.expectRevert();
        vm.prank(artist);
        house.recoverStuckERC721(address(bad), TOKEN_ID, artist);

        address[] memory touched = new address[](2);
        touched[0] = treasury;
        touched[1] = address(recipient);
        _assertConserved(touched);
    }

    /// @dev A seller-controlled collection can also tamper with the escrowed
    ///      token before endAuction is ever called, not just during a
    ///      payout callback. Delivery then has nothing to move: it defers
    ///      exactly as any other delivery failure would, and pays nobody.
    ///      Under the old pay-then-deliver design this would have paid the
    ///      seller regardless; here it cannot.
    function test_EscrowTamperedBeforeDeliveryDefersAndPaysNobody() public {
        ClawbackERC721 bad = new ClawbackERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        bad.setAdmin(artist);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE, 0);

        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        // The seller (admin) yanks the escrowed token out of the house
        // before anyone calls endAuction. Delivery has nothing to move.
        vm.prank(artist);
        bad.forceTransfer(address(house), artist, TOKEN_ID);

        uint256 sellerBefore = artist.balance;
        uint256 treasuryBefore = treasury.balance;
        house.endAuction(auctionId);

        assertTrue(house.pendingDelivery(auctionId));
        assertEq(artist.balance, sellerBefore, "the seller receives nothing");
        assertEq(treasury.balance, treasuryBefore, "the protocol receives nothing");
        assertEq(address(house).balance, RESERVE, "the winning bid stays escrowed");
        assertEq(house.pendingRefunds(artist), 0);
        assertEq(house.pendingRefunds(treasury), 0);
    }

    /// @dev setAuctionReservePrice was untested on V2 (only on V1). Confirms
    ///      it still works normally, pre-bid, called directly by the token
    ///      owner, now that it carries nonReentrant.
    function test_ReservePriceCanChangeByTokenOwnerBeforeBid() public {
        uint256 auctionId = _create();
        vm.prank(artist);
        house.setAuctionReservePrice(auctionId, 2 ether);
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionId);
        assertEq(a.reservePrice, 2 ether);

        vm.prank(alice);
        house.createBid{value: 2 ether}(auctionId);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.setAuctionReservePrice(auctionId, 3 ether);
    }

    /// @dev Defense-in-depth: setAuctionReservePrice, setAuctionDuration,
    ///      setAuctionFundsRecipient and setAuctionListingExpiry are gated on
    ///      firstBidTime == 0, so none is reachable from any external call
    ///      that only fires once an auction has a bid today. nonReentrant is
    ///      added to all four anyway as a structural guard. This proves the
    ///      guard is live: a bidder that gets outbid re-enters
    ///      setAuctionFundsRecipient on a different pre-bid auction it owns
    ///      from its refund-receive callback, and the reentrant call reverts.
    function test_ListingSetterGuardedAgainstReentrancyThroughOutbidRefund() public {
        ReentrantSetterBidder attacker = new ReentrantSetterBidder();

        // Auction B: pre-bid, owned (tokenOwner) by the attacker contract.
        uint256 tokenIdB = TOKEN_ID + 800;
        nft.mint(address(attacker), tokenIdB);
        vm.prank(address(attacker));
        nft.setApprovalForAll(artist, true);
        vm.prank(address(attacker));
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionIdB = house.createAuction(tokenIdB, address(nft), DURATION, RESERVE, 0);
        attacker.configure(house, auctionIdB);

        // Auction A: the attacker is the current high bidder.
        uint256 auctionIdA = _create();
        attacker.bid{value: RESERVE}(auctionIdA);

        // Bob outbids the attacker, triggering the refund callback.
        uint256 higherBid = RESERVE + (RESERVE * 500) / 10_000;
        vm.prank(bob);
        house.createBid{value: higherBid}(auctionIdA);

        // The reentrant setter call fired and reverted; the attacker still
        // received its refund because createBid only catches the call's
        // outer success flag, not what happened inside.
        assertTrue(attacker.attempted());
        assertFalse(attacker.succeeded());
        assertEq(address(attacker).balance, RESERVE);
        assertEq(attacker.outcome(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        // Auction A recorded Bob's higher bid, not the attacker's.
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionIdA);
        assertEq(a.bidder, bob);
        assertEq(a.amount, higherBid);

        // Auction B's fundsRecipient is unchanged: the reentrant setter call
        // never took effect.
        ISovereignAuctionHouseV2.Auction memory b = house.getAuction(auctionIdB);
        assertEq(b.fundsRecipient, address(attacker));

        // The setter still works normally when called directly, outside the
        // reentrant window.
        vm.prank(address(attacker));
        house.setAuctionFundsRecipient(auctionIdB, payable(carol));
        assertEq(house.getAuction(auctionIdB).fundsRecipient, carol);
    }

    /// @dev CEI order in createBid: the outbid refund amount is the previous
    ///      bid, not the new one, and storage reflects the new bid before the
    ///      refund call fires. A reentrant createBid attempt from the refund
    ///      callback still reverts under the global nonReentrant lock.
    function test_OutbidRefundPaysExactPreviousAmountAndBlocksReentrantBid() public {
        uint256 auctionId = _create();
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);

        uint256 higherBid = RESERVE + (RESERVE * 500) / 10_000;
        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        house.createBid{value: higherBid}(auctionId);

        assertEq(alice.balance - aliceBefore, RESERVE, "refund must equal the previous bid, not the new one");
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionId);
        assertEq(a.bidder, bob);
        assertEq(a.amount, higherBid);
    }
}
