// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";
import {MockERC721} from "./MockERC721.sol";

/// @dev Behaves normally for escrow, then can fail or no-op only on delivery.
contract MutableERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => mapping(address => bool)) internal _approvedForAll;
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
        if (noopOutbound && msg.sender == from) return;
        _ownerOf[tokenId] = to;
    }
}

contract RefundProxy {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function withdrawTo(address house, address payable recipient) external {
        SovereignAuctionHouseV2(payable(house)).withdrawRefundTo(recipient);
    }

    receive() external payable {
        revert("reject ETH");
    }
}

contract SovereignAuctionHouseV2Test is Test {
    SovereignAuctionHouseV2 internal house;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA01);
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
        return house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE);
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
        (,,,,,,,,, uint64 duration,,) = house.auctions(auctionId);
        assertEq(duration, 2 hours);
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

    function test_RevertingDeliveryRefundsWinnerAndProtectsLot() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);

        assertEq(house.pendingRefunds(alice), RESERVE);
        assertEq(artist.balance, sellerBefore);
        (bool active,) = house.getAuctionFor(address(bad), TOKEN_ID);
        (bool failed,) = house.getFailedAuctionFor(address(bad), TOKEN_ID);
        assertFalse(active);
        assertTrue(failed);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC721(address(bad), TOKEN_ID, artist);

        bad.setTransferMode(false, false);
        house.claimFailedLot(auctionId);
        assertEq(bad.ownerOf(TOKEN_ID), artist);
    }

    function test_SilentOutboundNoopUsesSameRefundPath() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setTransferMode(false, true);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(auctionId);
        assertEq(house.pendingRefunds(alice), RESERVE);
        assertEq(bad.ownerOf(TOKEN_ID), address(house));
    }

    function test_FailedWinnerCanWithdrawToWorkingRecipient() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, TOKEN_ID);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(TOKEN_ID, address(bad), DURATION, RESERVE);
        RefundProxy bidder = new RefundProxy();
        vm.deal(address(bidder), RESERVE);
        bidder.bid{value: RESERVE}(address(house), auctionId);
        bad.setTransferMode(true, false);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);

        uint256 bobBefore = bob.balance;
        bidder.withdrawTo(address(house), payable(bob));
        assertEq(house.pendingRefunds(address(bidder)), 0);
        assertEq(bob.balance - bobBefore, RESERVE);
    }

    function test_StandardContractBidderStillReceivesPlainTransfer() public {
        uint256 auctionId = _create();
        _bidAndEnd(auctionId, alice, RESERVE);
        house.endAuction(auctionId);
        assertEq(nft.ownerOf(TOKEN_ID), alice);
    }
}
