// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PndAuctionHouse} from "../src/PndAuctionHouse.sol";
import {PndAuctionHouseFactory} from "../src/PndAuctionHouseFactory.sol";
import {IPndAuctionHouse} from "../src/IPndAuctionHouse.sol";
import {UpgradeableBeacon} from "openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {MockERC721} from "./MockERC721.sol";
import {RevertingReceiver} from "./RevertingReceiver.sol";

contract PndAuctionHouseTest is Test {
    PndAuctionHouse internal house;
    PndAuctionHouseFactory internal factory;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA01);
    address internal pndAdmin = address(0xAD);
    address payable internal pndTreasury = payable(address(0xFEE));
    address internal beaconOwner = address(0xBEAC);
    address internal factoryOwner = address(0xFAC);

    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant DURATION = 24 hours;
    uint256 internal constant RESERVE = 1 ether;

    function setUp() public {
        nft = new MockERC721();
        nft.mint(artist, TOKEN_ID);

        // Deploy implementation + factory.
        PndAuctionHouse impl = new PndAuctionHouse();
        factory = new PndAuctionHouseFactory(
            address(impl),
            beaconOwner,
            factoryOwner,
            pndAdmin,
            pndTreasury,
            0 // 0% fee at launch
        );

        // Artist deploys their auction house.
        address houseAddr = factory.createAuctionHouse(artist);
        house = PndAuctionHouse(payable(houseAddr));

        // Artist approves their house to escrow the NFT.
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);

        // Fund bidders.
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ─── Initialization ──────────────────────────────────────────────────

    function test_Initialize_SetsState() public view {
        assertEq(house.owner(), artist);
        assertEq(house.protocolFeeAdmin(), pndAdmin);
        assertEq(house.feeRecipient(), pndTreasury);
        assertEq(house.protocolFeeBps(), 0);
    }

    function test_Initialize_CannotBeCalledAgain() public {
        vm.expectRevert();
        house.initialize(artist, pndAdmin, pndTreasury, 0);
    }

    function test_Initialize_RejectsFeeAboveCap() public {
        // Factory constructor's defaultProtocolFeeBps cap (500) catches it first.
        PndAuctionHouse impl = new PndAuctionHouse();
        vm.expectRevert("Above cap");
        new PndAuctionHouseFactory(
            address(impl),
            beaconOwner,
            factoryOwner,
            pndAdmin,
            pndTreasury,
            501
        );
    }

    // ─── Create auction ──────────────────────────────────────────────────

    function _createAuction() internal returns (uint256) {
        vm.prank(artist);
        return house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
    }

    function test_CreateAuction_EscrowsNftAndApproves() public {
        uint256 id = _createAuction();
        assertEq(nft.ownerOf(TOKEN_ID), address(house));
        (
            uint256 tokenId,
            address tokenContract,
            bool approved,
            uint256 amount,
            ,
            ,
            uint256 reservePrice,
            ,
            address tokenOwner,
            ,
            address curator
        ) = house.auctions(id);
        assertEq(tokenId, TOKEN_ID);
        assertEq(tokenContract, address(nft));
        assertTrue(approved); // No curator set => auto-approved
        assertEq(amount, 0);
        assertEq(reservePrice, RESERVE);
        assertEq(tokenOwner, artist);
        assertEq(curator, address(0));
    }

    function test_CreateAuction_RejectsCallerThatIsNotHouseOwner() public {
        // Even if alice owns an NFT she can't list it in another artist's house.
        nft.mint(alice, 99);
        vm.prank(alice);
        nft.setApprovalForAll(address(house), true);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.createAuction(99, address(nft), DURATION, RESERVE, payable(address(0)), 0);
    }

    function test_CreateAuction_RejectsArtistWhoDoesNotOwnTheNFT() public {
        // Artist owns the house but not this token -> ownerOf check still applies.
        nft.mint(alice, 42);
        vm.prank(artist);
        vm.expectRevert("Not token owner or approved");
        house.createAuction(42, address(nft), DURATION, RESERVE, payable(address(0)), 0);
    }

    function test_CreateAuction_RejectsNonERC721() public {
        // Artist (an EOA) is not ERC721 — supportsInterface call will fail.
        vm.prank(artist);
        vm.expectRevert();
        house.createAuction(TOKEN_ID, artist, DURATION, RESERVE, payable(address(0)), 0);
    }

    function test_CreateAuction_RejectsZeroDuration() public {
        vm.prank(artist);
        vm.expectRevert("duration zero");
        house.createAuction(TOKEN_ID, address(nft), 0, RESERVE, payable(address(0)), 0);
    }

    function test_CreateAuction_RejectsCuratorFeeAt100Pct() public {
        vm.prank(artist);
        vm.expectRevert("curator fee >= 100%");
        house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE, payable(carol), 10000);
    }

    function test_CreateAuction_WithCurator_NotAutoApproved() public {
        vm.prank(artist);
        uint256 id = house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE, payable(carol), 1000);
        (,, bool approved,,,,,,,,) = house.auctions(id);
        assertFalse(approved);
    }

    // ─── Bid validation ──────────────────────────────────────────────────

    function test_Bid_RejectsBelowReserve() public {
        uint256 id = _createAuction();
        vm.expectRevert("Below reserve price");
        vm.prank(alice);
        house.createBid{value: RESERVE - 1}(id);
    }

    function test_Bid_AcceptsAtReserve() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        (,,, uint256 amount,, uint256 firstBidTime,,,, address payable bidder,) = house.auctions(id);
        assertEq(amount, RESERVE);
        assertEq(bidder, alice);
        assertGt(firstBidTime, 0);
    }

    function test_Bid_RejectsBelowMinIncrement() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        // 5% increment over RESERVE = RESERVE * 1.05
        uint256 tooLow = RESERVE + (RESERVE * 499) / 10000; // < 5% bump
        vm.expectRevert("Below min bid increment");
        vm.prank(bob);
        house.createBid{value: tooLow}(id);
    }

    function test_Bid_AcceptsAtMinIncrement() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);
        (,,, uint256 amount,,,,,, address payable bidder,) = house.auctions(id);
        assertEq(amount, minNext);
        assertEq(bidder, bob);
    }

    function test_Bid_RefundsPriorBidder() public {
        uint256 id = _createAuction();
        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);

        // Alice should have her ETH back (sent RESERVE, received RESERVE).
        assertEq(alice.balance, aliceBalanceBefore);
    }

    function test_Bid_RejectsAfterExpiry() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        vm.warp(block.timestamp + DURATION + 1);
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.expectRevert("Auction expired");
        vm.prank(bob);
        house.createBid{value: minNext}(id);
    }

    function test_Bid_RejectsWhenNotApproved() public {
        vm.prank(artist);
        uint256 id = house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(carol), // Curator set, so not auto-approved
            500
        );
        vm.expectRevert("Auction not approved");
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
    }

    // ─── Late-bid time extension ─────────────────────────────────────────

    function test_LateBid_ExtendsDuration() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        // Jump to inside the 15-minute buffer.
        vm.warp(block.timestamp + DURATION - 5 minutes);
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;

        vm.prank(bob);
        house.createBid{value: minNext}(id);

        ( , , , , uint256 dur, uint256 firstBid, , , , , ) = house.auctions(id);
        // firstBid + dur should be at least block.timestamp + 15 minutes
        assertGe(firstBid + dur, block.timestamp + 15 minutes);
    }

    function test_EarlyBid_DoesNotExtend() public {
        uint256 id = _createAuction();
        uint256 originalDuration = DURATION;
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        // Bid plenty of time before the buffer.
        vm.warp(block.timestamp + 1 hours);
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);

        ( , , , , uint256 dur, , , , , , ) = house.auctions(id);
        assertEq(dur, originalDuration);
    }

    // ─── End auction ─────────────────────────────────────────────────────

    function test_EndAuction_PaysSellerInFull_NoFees() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(id);

        assertEq(nft.ownerOf(TOKEN_ID), alice);
        assertEq(artist.balance - sellerBefore, RESERVE);
    }

    function test_EndAuction_RejectsBeforeEnd() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.expectRevert("Auction not yet ended");
        house.endAuction(id);
    }

    function test_EndAuction_RejectsWithoutBids() public {
        uint256 id = _createAuction();
        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert("Auction has no bids");
        house.endAuction(id);
    }

    function test_EndAuction_PaysProtocolFee() public {
        // PND admin sets fee to 2.5%
        vm.prank(pndAdmin);
        house.setProtocolFeeBps(250);

        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 feeRecipientBefore = pndTreasury.balance;
        house.endAuction(id);

        uint256 expectedFee = (RESERVE * 250) / 10000;
        assertEq(pndTreasury.balance - feeRecipientBefore, expectedFee);
        assertEq(artist.balance - sellerBefore, RESERVE - expectedFee);
    }

    function test_EndAuction_PaysCuratorFee() public {
        // Auction with carol as curator @ 10%
        vm.prank(artist);
        uint256 id = house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(carol),
            1000
        );
        vm.prank(carol);
        house.setAuctionApproval(id, true);

        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 carolBefore = carol.balance;
        house.endAuction(id);

        uint256 curatorFee = (RESERVE * 1000) / 10000;
        assertEq(carol.balance - carolBefore, curatorFee);
        assertEq(artist.balance - sellerBefore, RESERVE - curatorFee);
    }

    function test_EndAuction_PaysProtocolThenCurator() public {
        // Both fees: protocol 5%, curator 10% (of remainder)
        vm.prank(pndAdmin);
        house.setProtocolFeeBps(500);

        vm.prank(artist);
        uint256 id = house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(carol),
            1000
        );
        vm.prank(carol);
        house.setAuctionApproval(id, true);

        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 protocolFee = (RESERVE * 500) / 10000; // 5% of total
        uint256 afterProtocol = RESERVE - protocolFee;
        uint256 curatorFee = (afterProtocol * 1000) / 10000; // 10% of rest
        uint256 sellerProceeds = afterProtocol - curatorFee;

        uint256 sellerBefore = artist.balance;
        uint256 carolBefore = carol.balance;
        uint256 treasuryBefore = pndTreasury.balance;
        house.endAuction(id);

        assertEq(pndTreasury.balance - treasuryBefore, protocolFee);
        assertEq(carol.balance - carolBefore, curatorFee);
        assertEq(artist.balance - sellerBefore, sellerProceeds);
        // Total accounted for
        assertEq(protocolFee + curatorFee + sellerProceeds, RESERVE);
    }

    // ─── Cancel + update reserve ─────────────────────────────────────────

    function test_CancelAuction_ReturnsNftToOwner() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.cancelAuction(id);
        assertEq(nft.ownerOf(TOKEN_ID), artist);
    }

    function test_CancelAuction_RejectedAfterFirstBid() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.expectRevert("Auction already started");
        vm.prank(artist);
        house.cancelAuction(id);
    }

    function test_CancelAuction_RejectsNonOwner() public {
        uint256 id = _createAuction();
        vm.expectRevert("Not auction creator or curator");
        vm.prank(alice);
        house.cancelAuction(id);
    }

    function test_UpdateReserve_OnlyBeforeBids() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.setAuctionReservePrice(id, 2 ether);
        ( , , , , , , uint256 reserve, , , , ) = house.auctions(id);
        assertEq(reserve, 2 ether);

        vm.prank(alice);
        house.createBid{value: 2 ether}(id);

        vm.expectRevert("Auction already started");
        vm.prank(artist);
        house.setAuctionReservePrice(id, 3 ether);
    }

    // ─── Protocol fee admin ──────────────────────────────────────────────

    function test_SetProtocolFee_OnlyAdmin() public {
        vm.expectRevert("Not protocol fee admin");
        vm.prank(artist);
        house.setProtocolFeeBps(100);
    }

    function test_SetProtocolFee_RespectsCap() public {
        vm.expectRevert("Above cap");
        vm.prank(pndAdmin);
        house.setProtocolFeeBps(501);
    }

    function test_SetProtocolFee_AcceptsAtCap() public {
        vm.prank(pndAdmin);
        house.setProtocolFeeBps(500);
        assertEq(house.protocolFeeBps(), 500);
    }

    function test_SetProtocolFeeAdmin_TransfersControl() public {
        address newAdmin = address(0xBEEF);
        vm.prank(pndAdmin);
        house.setProtocolFeeAdmin(newAdmin);

        // Old admin can no longer set
        vm.expectRevert("Not protocol fee admin");
        vm.prank(pndAdmin);
        house.setProtocolFeeBps(100);

        // New admin can
        vm.prank(newAdmin);
        house.setProtocolFeeBps(100);
        assertEq(house.protocolFeeBps(), 100);
    }

    // ─── Refund fallback ─────────────────────────────────────────────────

    function test_Refund_FallsBackToPullPaymentWhenSendFails() public {
        RevertingReceiver bidder = new RevertingReceiver();
        vm.deal(address(bidder), 10 ether);

        uint256 id = _createAuction();

        // Reverting bidder makes the first bid.
        bidder.bid(payable(address(house)), id, RESERVE);

        // Bob outbids — refund to bidder will fail and fall back to ledger.
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);

        // Bidder now has a pending refund equal to RESERVE.
        assertEq(house.pendingRefunds(address(bidder)), RESERVE);
        // But still no ETH at the bidder address since send failed.
        assertEq(address(bidder).balance, 10 ether - RESERVE);

        // Withdrawing via withdrawRefund() also fails (still reverts on receive),
        // so the balance stays. This validates the ledger holds funds safely.
        vm.expectRevert();
        bidder.withdraw(payable(address(house)));
        assertEq(house.pendingRefunds(address(bidder)), RESERVE);
    }

    // ─── Factory ─────────────────────────────────────────────────────────

    function test_Factory_RejectsDuplicateForArtist() public {
        vm.expectRevert("House already exists");
        factory.createAuctionHouse(artist);
    }

    function test_Factory_TracksAllHouses() public {
        address bob_house = factory.createAuctionHouse(bob);
        assertEq(factory.totalHouses(), 2);
        assertEq(factory.houseOf(bob), bob_house);
        assertEq(factory.allHouses(0), address(house));
        assertEq(factory.allHouses(1), bob_house);
    }

    function test_Factory_IsHouseFlagSet() public view {
        assertTrue(factory.isHouse(address(house)));
        assertFalse(factory.isHouse(alice));
    }

    // ─── Per-token auction lookup ────────────────────────────────────────

    function test_TokenLookup_ReturnsAuctionId() public {
        uint256 id = _createAuction();
        assertTrue(house.hasAuctionFor(address(nft), TOKEN_ID));
        assertEq(house.getAuctionIdFor(address(nft), TOKEN_ID), id);
    }

    function test_TokenLookup_ClearedOnCancel() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.cancelAuction(id);
        assertFalse(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    function test_TokenLookup_ClearedOnSettle() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertFalse(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    function test_TokenLookup_NoneByDefault() public view {
        assertFalse(house.hasAuctionFor(address(nft), 999));
        assertEq(house.getAuctionIdFor(address(nft), 999), 0);
    }
}
