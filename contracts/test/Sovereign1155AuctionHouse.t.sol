// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/ERC1155.sol";
import {IERC1155Receiver} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155Receiver.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {MockERC721} from "./MockERC721.sol";
import {PausableERC1155} from "./PausableERC1155.sol";

contract MockAuctionERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

/// @dev Valid on inbound escrow, then deliberately breaks outgoing delivery.
contract MutableERC1155 {
    mapping(address => mapping(uint256 => uint256)) internal _balanceOf;
    mapping(address => mapping(address => bool)) internal _approved;
    bool public breakOutbound;

    function mint(address to, uint256 id, uint256 amount) external {
        _balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approved[msg.sender][operator] = approved;
    }

    function setBreakOutbound(bool value) external {
        breakOutbound = value;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26;
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balanceOf[account][id];
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _approved[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        require(msg.sender == from || _approved[from][msg.sender], "not approved");
        require(_balanceOf[from][id] >= amount, "insufficient balance");
        if (breakOutbound && msg.sender == from) revert("delivery blocked");
        _balanceOf[from][id] -= amount;
        _balanceOf[to][id] += amount;
        if (to.code.length != 0) {
            require(
                IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, amount, data)
                    == IERC1155Receiver.onERC1155Received.selector,
                "receiver rejected"
            );
        }
    }
}

/// @dev Contract wallet that bids and correctly accepts ERC1155 delivery.
contract AcceptingERC1155Bidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function claim(address house, uint256 auctionId, address to) external {
        SovereignAuctionHouseV2(payable(house)).claimLot(auctionId, to);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }
}

/// @dev Contract wallet that bids but rejects ERC1155 delivery, forcing a
///      deferral. Its own rejection cannot force a refund: the seller is
///      already paid, and it can still redirect the eventual claim.
contract RejectingERC1155Bidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function claim(address house, uint256 auctionId, address to) external {
        SovereignAuctionHouseV2(payable(house)).claimLot(auctionId, to);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert("reject delivery");
    }
}

contract Sovereign1155AuctionHouseTest is Test {
    SovereignAuctionHouseV2 internal house;
    MockAuctionERC1155 internal token;
    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal carol = address(0xCA01);
    address payable internal treasury = payable(address(0xFEE));
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant QUANTITY = 5;
    uint256 internal constant RESERVE = 1 ether;
    uint256 internal constant DURATION = 24 hours;

    function setUp() public {
        token = new MockAuctionERC1155();
        token.mint(artist, TOKEN_ID, 10);
        SovereignAuctionHouseV2 impl = new SovereignAuctionHouseV2();
        SovereignAuctionHouseV2Factory factory = new SovereignAuctionHouseV2Factory(address(impl), treasury, 250);
        vm.prank(artist);
        house = SovereignAuctionHouseV2(payable(factory.createAuctionHouse()));
        vm.prank(artist);
        token.setApprovalForAll(address(house), true);
        vm.deal(alice, 10 ether);
    }

    /// @dev The curator fee splits the hammer price the same way on an 1155
    ///      settle as it does for ERC721: protocol fee to feeRecipient,
    ///      curator fee to owner(), remainder to fundsRecipient.
    function test_CuratorFeeAppliesIdenticallyOn1155Settle() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 1000);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(carol));
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 treasuryBefore = treasury.balance;
        uint256 curatorBefore = artist.balance;
        uint256 carolBefore = carol.balance;
        house.endAuction(auctionId);

        uint256 protocolFee = (RESERVE * 250) / 10_000;
        uint256 curatorFee = (RESERVE * 1000) / 10_000;
        uint256 sellerProceeds = RESERVE - protocolFee - curatorFee;

        assertEq(treasury.balance - treasuryBefore, protocolFee);
        assertEq(artist.balance - curatorBefore, curatorFee);
        assertEq(carol.balance - carolBefore, sellerProceeds);
        assertEq(token.balanceOf(alice, TOKEN_ID), QUANTITY);
    }

    function test_WholeLotSettlesToEoaWinnerAndPaysFundsRecipient() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(carol));
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 carolBefore = carol.balance;
        house.endAuction(auctionId);
        uint256 fee = (RESERVE * 250) / 10_000;
        assertEq(token.balanceOf(alice, TOKEN_ID), QUANTITY);
        assertEq(token.balanceOf(artist, TOKEN_ID), 10 - QUANTITY);
        assertEq(carol.balance - carolBefore, RESERVE - fee);
        assertFalse(house.pendingDelivery(auctionId));
    }

    function test_SameHouseCanCreate721And1155Lots() public {
        vm.prank(artist);
        uint256 erc1155AuctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);

        MockERC721 nft = new MockERC721();
        nft.mint(artist, 2);
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 erc721AuctionId = house.createAuction(2, address(nft), DURATION, RESERVE, 0);

        ISovereignAuctionHouseV2.Auction memory a1155 = house.getAuction(erc1155AuctionId);
        ISovereignAuctionHouseV2.Auction memory a721 = house.getAuction(erc721AuctionId);
        assertEq(a1155.quantity, QUANTITY);
        assertEq(uint8(a1155.standard), 1);
        assertEq(a721.quantity, 1);
        assertEq(uint8(a721.standard), 0);
    }

    /// @dev EIP-7702 code appearing on a bidder after it bid, or any other
    ///      contract-code bidder, is no longer special-cased: the seller is
    ///      always paid at endAuction, so a winner opting out of delivery
    ///      gains nothing and only its own claim is affected.
    function test_ContractCodeOnBidderNoLongerBlocksSettlement() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);

        // Models a bidder adding delegated EIP-7702 code after it bid.
        vm.etch(alice, hex"00");
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
    }

    function test_BrokenDeliveryDefersLotButSellerIsPaidInFull() public {
        MutableERC1155 bad = new MutableERC1155();
        bad.mint(artist, TOKEN_ID, QUANTITY);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(bad), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBreakOutbound(true);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertEq(bad.balanceOf(address(house), TOKEN_ID), QUANTITY);
        assertTrue(house.pendingDelivery(auctionId));
        (bool active,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertTrue(active);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC1155(address(bad), TOKEN_ID, QUANTITY, artist);

        bad.setBreakOutbound(false);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(bad.balanceOf(alice, TOKEN_ID), QUANTITY);
    }

    /// @dev claimLot without a pending delivery reverts.
    function test_ClaimLotWithoutPendingDeliveryReverts() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        house.endAuction(auctionId);
        assertFalse(house.pendingDelivery(auctionId));
        vm.expectRevert(SovereignAuctionHouseV2.NoPendingDelivery.selector);
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
    }

    /// @dev Contract wallets are no longer banned from bidding on ERC1155
    ///      lots. One that correctly implements the receiver hook wins and
    ///      is delivered to directly, with no deferral.
    function test_ContractWalletCanBidAndWinDirectly() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        AcceptingERC1155Bidder bidder = new AcceptingERC1155Bidder();
        vm.deal(address(bidder), RESERVE);
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(auctionId);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(token.balanceOf(address(bidder), TOKEN_ID), QUANTITY);
    }

    /// @dev A winner whose onERC1155Received reverts is deferred, not
    ///      refunded; the seller keeps being paid at endAuction, and the
    ///      winner can redirect its own claim to a working EOA.
    function test_RejectingContractWinnerIsDeferredThenClaimsToRedirect() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        RejectingERC1155Bidder bidder = new RejectingERC1155Bidder();
        vm.deal(address(bidder), RESERVE);
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(token.balanceOf(address(house), TOKEN_ID), QUANTITY);

        bidder.claim(address(house), auctionId, carol);
        assertEq(token.balanceOf(carol, TOKEN_ID), QUANTITY);
        assertFalse(house.pendingDelivery(auctionId));
    }

    function test_UnsolicitedSafeTransferIsRejected() public {
        vm.expectRevert(SovereignAuctionHouseV2.EscrowFailed.selector);
        vm.prank(artist);
        token.safeTransferFrom(artist, address(house), TOKEN_ID, 1, "");
    }

    /// @dev Paused delivery defers the lot; the winner claims once unpaused.
    function test_PausedCollectionDefersDeliveryThenClaimSucceedsAfterUnpause() public {
        PausableERC1155 paused = new PausableERC1155();
        paused.mint(artist, TOKEN_ID, QUANTITY);
        vm.prank(artist);
        paused.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(paused), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        paused.pause();
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));

        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        paused.unpause();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(paused.balanceOf(alice, TOKEN_ID), QUANTITY);
    }
}
