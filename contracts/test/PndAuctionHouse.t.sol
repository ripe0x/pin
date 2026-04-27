// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PndAuctionHouse} from "../src/PndAuctionHouse.sol";
import {PndAuctionHouseFactory} from "../src/PndAuctionHouseFactory.sol";
import {IPndAuctionHouse} from "../src/IPndAuctionHouse.sol";
import {MockERC721} from "./MockERC721.sol";
import {NoopERC721} from "./NoopERC721.sol";
import {RevertingReceiver} from "./RevertingReceiver.sol";
import {NonReceivingBidder} from "./NonReceivingBidder.sol";

contract PndAuctionHouseTest is Test {
    PndAuctionHouse internal house;
    PndAuctionHouseFactory internal factory;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA01);
    address payable internal pndTreasury = payable(address(0xFEE));

    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant DURATION = 24 hours;
    uint256 internal constant RESERVE = 1 ether;

    function setUp() public {
        nft = new MockERC721();
        nft.mint(artist, TOKEN_ID);

        // Deploy implementation + factory (fully immutable, no admin).
        PndAuctionHouse impl = new PndAuctionHouse();
        factory = new PndAuctionHouseFactory(
            address(impl),
            pndTreasury,
            0 // 0% fee, locked forever for this factory
        );

        // Artist deploys their auction house. createAuctionHouse uses
        // msg.sender as the artist, so prank.
        vm.prank(artist);
        address houseAddr = factory.createAuctionHouse();
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
        assertEq(house.feeRecipient(), pndTreasury);
        assertEq(house.protocolFeeBps(), 0);
    }

    function test_Initialize_CannotBeCalledAgain() public {
        vm.expectRevert();
        house.initialize(artist, pndTreasury, 0);
    }

    function test_FactoryConstructor_RejectsFeeAboveCap() public {
        PndAuctionHouse impl = new PndAuctionHouse();
        vm.expectRevert("fee above cap");
        new PndAuctionHouseFactory(address(impl), pndTreasury, 501);
    }

    // ─── Immutability — no setters exist on the impl ─────────────────────

    function test_Immutability_NoFeeSetter() public {
        // setProtocolFeeBps is gone — calling its old selector reverts with no match.
        (bool ok, ) = address(house).call(
            abi.encodeWithSignature("setProtocolFeeBps(uint16)", 100)
        );
        assertFalse(ok);
    }

    function test_Immutability_NoFeeRecipientSetter() public {
        (bool ok, ) = address(house).call(
            abi.encodeWithSignature("setFeeRecipient(address)", address(0xC0FFEE))
        );
        assertFalse(ok);
    }

    function test_Immutability_NoAdminSetter() public {
        (bool ok, ) = address(house).call(
            abi.encodeWithSignature("setProtocolFeeAdmin(address)", address(0xC0FFEE))
        );
        assertFalse(ok);
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
        vm.expectRevert(PndAuctionHouse.BidBelowReserve.selector);
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
        vm.expectRevert(PndAuctionHouse.BidBelowMinimum.selector);
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
        vm.expectRevert(PndAuctionHouse.AuctionExpired.selector);
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
        vm.expectRevert(PndAuctionHouse.AuctionNotApproved.selector);
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
        vm.expectRevert(PndAuctionHouse.AuctionNotEnded.selector);
        house.endAuction(id);
    }

    function test_EndAuction_RejectsWithoutBids() public {
        uint256 id = _createAuction();
        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert(PndAuctionHouse.AuctionHasNoBids.selector);
        house.endAuction(id);
    }

    /// @dev Spin up a fresh fee-charging factory + house to test the fee path.
    ///      The default `house` is at 0% (locked). Per immutable design, a new
    ///      factory is the only way to vary protocol fee.
    function _newHouseWithFee(uint16 feeBps) internal returns (PndAuctionHouse h, uint256 nftTokenId) {
        PndAuctionHouse impl = new PndAuctionHouse();
        PndAuctionHouseFactory feeFactory = new PndAuctionHouseFactory(
            address(impl),
            pndTreasury,
            feeBps
        );
        vm.prank(artist);
        h = PndAuctionHouse(payable(feeFactory.createAuctionHouse()));
        nftTokenId = uint256(uint160(address(h))) % 1_000_000 + 10_000;
        nft.mint(artist, nftTokenId);
        vm.prank(artist);
        nft.setApprovalForAll(address(h), true);
    }

    function test_EndAuction_PaysProtocolFee() public {
        (PndAuctionHouse h, uint256 tokenId) = _newHouseWithFee(250); // 2.5%

        vm.prank(artist);
        uint256 id = h.createAuction(
            tokenId,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
        vm.prank(alice);
        h.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 feeRecipientBefore = pndTreasury.balance;
        h.endAuction(id);

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
        // Protocol 5% (locked at factory), curator 10% (per-auction)
        (PndAuctionHouse h, uint256 tokenId) = _newHouseWithFee(500);

        vm.prank(artist);
        uint256 id = h.createAuction(
            tokenId,
            address(nft),
            DURATION,
            RESERVE,
            payable(carol),
            1000
        );
        vm.prank(carol);
        h.setAuctionApproval(id, true);

        vm.prank(alice);
        h.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 protocolFee = (RESERVE * 500) / 10000; // 5% of total
        uint256 afterProtocol = RESERVE - protocolFee;
        uint256 curatorFee = (afterProtocol * 1000) / 10000; // 10% of rest
        uint256 sellerProceeds = afterProtocol - curatorFee;

        uint256 sellerBefore = artist.balance;
        uint256 carolBefore = carol.balance;
        uint256 treasuryBefore = pndTreasury.balance;
        h.endAuction(id);

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
        vm.expectRevert(PndAuctionHouse.AuctionAlreadyStarted.selector);
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

        vm.expectRevert(PndAuctionHouse.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.setAuctionReservePrice(id, 3 ether);
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
        vm.prank(artist);
        factory.createAuctionHouse();
    }

    function test_Factory_TracksAllHouses() public {
        vm.prank(bob);
        address bob_house = factory.createAuctionHouse();
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
        (bool exists, uint256 auctionId) = house.getAuctionFor(address(nft), TOKEN_ID);
        assertTrue(exists);
        assertEq(auctionId, id);
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
        (bool exists, uint256 auctionId) = house.getAuctionFor(address(nft), 999);
        assertFalse(exists);
        assertEq(auctionId, 0);
    }

    /// @dev With auctionId 0 being a real, valid id, the old single-uint
    ///      getter couldn't disambiguate "no auction" from "auction 0" without
    ///      another check. The new tuple makes the distinction explicit.
    function test_TokenLookup_AuctionIdZeroIsDistinctFromMissing() public {
        uint256 id0 = _createAuction(); // first auction is id 0
        assertEq(id0, 0);
        (bool exists, uint256 auctionId) = house.getAuctionFor(address(nft), TOKEN_ID);
        assertTrue(exists);
        assertEq(auctionId, 0);

        (bool missingExists, uint256 missingId) = house.getAuctionFor(address(nft), 9999);
        assertFalse(missingExists);
        assertEq(missingId, 0);
    }

    // ─── Bulk cancel ─────────────────────────────────────────────────────

    function _createBulkAuctions(uint256 count) internal returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = 100 + i;
            nft.mint(artist, tokenId);
            vm.prank(artist);
            ids[i] = house.createAuction(
                tokenId,
                address(nft),
                DURATION,
                RESERVE,
                payable(address(0)),
                0
            );
        }
    }

    function test_BulkCancel_ReturnsAllNftsToOwner() public {
        uint256[] memory ids = _createBulkAuctions(3);
        // All NFTs are now in the house contract.
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(nft.ownerOf(100 + i), address(house));
        }

        vm.prank(artist);
        house.bulkCancelAuctions(ids);

        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(nft.ownerOf(100 + i), artist);
            assertFalse(house.hasAuctionFor(address(nft), 100 + i));
        }
    }

    function test_BulkCancel_RejectsNonOwner() public {
        uint256[] memory ids = _createBulkAuctions(2);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.bulkCancelAuctions(ids);
    }

    function test_BulkCancel_RevertsIfAnyHasBid() public {
        uint256[] memory ids = _createBulkAuctions(3);
        // Bid on the middle one, ruining the batch.
        vm.prank(alice);
        house.createBid{value: RESERVE}(ids[1]);

        vm.expectRevert(PndAuctionHouse.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.bulkCancelAuctions(ids);

        // Atomicity: nothing was cancelled even though ids[0] could have been.
        for (uint256 i = 0; i < ids.length; i++) {
            assertTrue(house.hasAuctionFor(address(nft), 100 + i));
        }
    }

    function test_BulkCancel_RevertsOnNonexistentId() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = _createAuction();
        ids[1] = 99999; // doesn't exist

        vm.expectRevert(PndAuctionHouse.AuctionDoesNotExist.selector);
        vm.prank(artist);
        house.bulkCancelAuctions(ids);

        // Atomicity preserved.
        assertTrue(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    function test_BulkCancel_EmptyArrayIsNoOp() public {
        uint256[] memory ids = new uint256[](0);
        vm.prank(artist);
        house.bulkCancelAuctions(ids); // should not revert
    }

    // ─── Bulk create ─────────────────────────────────────────────────────

    function _bulkMintTokens(uint256 count) internal returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = 200 + i;
            nft.mint(artist, ids[i]);
        }
    }

    function test_BulkCreate_EscrowsAllAndReturnsIds() public {
        uint256[] memory tokenIds = _bulkMintTokens(3);

        vm.prank(artist);
        uint256[] memory auctionIds = house.bulkCreateAuctions(
            address(nft),
            tokenIds,
            RESERVE,
            DURATION,
            payable(address(0)),
            0
        );

        assertEq(auctionIds.length, 3);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            assertEq(nft.ownerOf(tokenIds[i]), address(house));
            assertTrue(house.hasAuctionFor(address(nft), tokenIds[i]));
            (
                ,
                ,
                bool approved,
                ,
                ,
                ,
                uint256 reserve,
                ,
                address tokenOwner,
                ,

            ) = house.auctions(auctionIds[i]);
            assertTrue(approved); // no curator => auto-approved
            assertEq(reserve, RESERVE);
            assertEq(tokenOwner, artist);
        }
    }

    function test_BulkCreate_RejectsNonOwner() public {
        uint256[] memory tokenIds = _bulkMintTokens(2);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.bulkCreateAuctions(
            address(nft),
            tokenIds,
            RESERVE,
            DURATION,
            payable(address(0)),
            0
        );
    }

    function test_BulkCreate_RevertsIfArtistDoesntOwnOne() public {
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = 300;
        tokenIds[1] = 301;
        nft.mint(artist, 300);
        nft.mint(alice, 301); // artist doesn't own this one

        vm.expectRevert("Not token owner or approved");
        vm.prank(artist);
        house.bulkCreateAuctions(
            address(nft),
            tokenIds,
            RESERVE,
            DURATION,
            payable(address(0)),
            0
        );

        // Atomicity: token 300 should still be with artist, no auction created.
        assertEq(nft.ownerOf(300), artist);
        assertFalse(house.hasAuctionFor(address(nft), 300));
    }

    function test_BulkCreate_EmptyArrayIsNoOp() public {
        uint256[] memory tokenIds = new uint256[](0);
        vm.prank(artist);
        uint256[] memory result = house.bulkCreateAuctions(
            address(nft),
            tokenIds,
            RESERVE,
            DURATION,
            payable(address(0)),
            0
        );
        assertEq(result.length, 0);
    }

    // ─── Security fixes from the pre-deploy review ────────────────────────

    /// #1 — Direct safeTransferFrom into the house must revert. The contract
    /// no longer implements IERC721Receiver, so any ERC721 sent outside the
    /// auction-creation flow is rejected at the source. NFTs cannot get stuck.
    function test_DirectSafeTransfer_Reverts() public {
        nft.mint(alice, 777);
        vm.prank(alice);
        vm.expectRevert(); // ERC721InvalidReceiver
        nft.safeTransferFrom(alice, address(house), 777);
    }

    /// #2 — A contract bidder without IERC721Receiver no longer aborts
    /// settlement. The previous design used safeTransferFrom + try/catch and
    /// silently cancelled the auction (refunding the winner's bid) when the
    /// transfer failed — a griefing path. Now plain transferFrom lands the
    /// NFT on the contract regardless of whether the recipient implements the
    /// receiver hook; the auction settles, the seller is paid, and the
    /// bidder owns an NFT they can't easily move. Their problem, not the
    /// seller's.
    function test_BidderCantReceiveNFT_StillSettles() public {
        NonReceivingBidder bidder = new NonReceivingBidder();
        vm.deal(address(bidder), 10 ether);

        uint256 id = _createAuction();
        bidder.bid(payable(address(house)), id, RESERVE);

        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(id);

        // NFT delivered to the contract bidder via plain transferFrom.
        assertEq(nft.ownerOf(TOKEN_ID), address(bidder));
        // Seller paid in full (no protocol fee on the default 0%-fee house).
        assertEq(artist.balance - sellerBefore, RESERVE);
        // Auction record cleared.
        assertFalse(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    /// #3 — Zero-value bids are rejected with BidMustBePositive even when
    /// reservePrice is 0. Closes the "free auction at reserve=0" gap.
    function test_Bid_RejectsZeroValueWithZeroReserve() public {
        // Use a fresh token for a zero-reserve auction.
        nft.mint(artist, 555);
        vm.prank(artist);
        uint256 id = house.createAuction(
            555,
            address(nft),
            DURATION,
            0, // zero reserve
            payable(address(0)),
            0
        );

        vm.expectRevert(PndAuctionHouse.BidMustBePositive.selector);
        vm.prank(alice);
        house.createBid{value: 0}(id);
    }

    /// #10 — Curator fee with no curator is rejected at create time.
    function test_CreateAuction_RejectsCuratorFeeWithoutCurator() public {
        vm.prank(artist);
        vm.expectRevert("curator fee without curator");
        house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)), // no curator
            500 // but a fee is set — invalid
        );
    }

    /// #7 — Direct ETH sends are rejected so accidental transfers don't get
    /// stuck in the contract.
    function test_DirectETHTransfer_Reverts() public {
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok, ) = address(house).call{value: 1 ether}("");
        assertFalse(ok);
    }

    /// #8 — Factory rejects an EOA-or-empty implementation.
    function test_FactoryConstructor_RejectsEOAImplementation() public {
        // alice is an EOA (no code).
        vm.expectRevert("implementation has no code");
        new PndAuctionHouseFactory(alice, pndTreasury, 0);
    }

    /// #8 — Factory rejects address(0) explicitly with the impl-required check.
    function test_FactoryConstructor_RejectsZeroImpl() public {
        vm.expectRevert("impl required");
        new PndAuctionHouseFactory(address(0), pndTreasury, 0);
    }

    /// Factory event includes immutable fee terms.
    function test_Factory_EmitsFeeTermsInEvent() public {
        // Topics: artist, house. Data: feeRecipient, protocolFeeBps.
        vm.expectEmit(true, false, false, true);
        emit PndAuctionHouseFactory.AuctionHouseCreated(
            bob,
            address(0), // we don't predict house addr; second indexed not strict
            pndTreasury,
            0
        );
        vm.prank(bob);
        factory.createAuctionHouse();
    }

    // ─── Ownership lockdown ──────────────────────────────────────────────

    function test_Lock_TransferOwnershipReverts() public {
        vm.prank(artist);
        vm.expectRevert(PndAuctionHouse.OwnershipLocked.selector);
        house.transferOwnership(alice);
    }

    function test_Lock_RenounceOwnershipReverts() public {
        vm.prank(artist);
        vm.expectRevert(PndAuctionHouse.OwnershipLocked.selector);
        house.renounceOwnership();
    }

    // ─── Direct ERC721 transfer rejection ──────────────────────────────

    function test_DirectERC721SafeTransfer_Reverts() public {
        nft.mint(alice, 777);
        vm.prank(alice);
        vm.expectRevert(); // ERC721InvalidReceiver
        nft.safeTransferFrom(alice, address(house), 777);
    }

    // ─── Duplicate-listing prevention (one auction per token id) ─────────

    function test_DuplicateAuctionForERC721_Reverts() public {
        _createAuction();
        // The reverse-lookup check fires first now (before the ownership
        // gate), so the second create reverts explicitly with the dedicated
        // error rather than tripping on the (also-true) "not owner anymore"
        // condition.
        vm.expectRevert(PndAuctionHouse.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
    }


    function test_AfterCancel_CanRelist_ERC721() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.cancelAuction(id);

        // Now relist.
        vm.prank(artist);
        uint256 id2 = house.createAuction(
            TOKEN_ID,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
        assertEq(id2, id + 1);
        assertTrue(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    function test_AfterSettle_CanRelistDifferentToken() public {
        // After a settle the lookup is cleared, so another holder of the
        // same token contract + tokenId could relist. Same token id, fresh
        // mint, fresh seller (still artist for our flow).
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);

        // Alice now owns TOKEN_ID, but artist owns the house. Test the
        // simpler case: relist a freshly-minted token.
        nft.mint(artist, 1234);
        vm.prank(artist);
        uint256 id2 = house.createAuction(
            1234,
            address(nft),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
        assertTrue(house.hasAuctionFor(address(nft), 1234));
        assertFalse(house.hasAuctionFor(address(nft), TOKEN_ID));
        assertEq(id2, id + 1);
    }

    // ─── Refund withdrawal explicit cases ────────────────────────────────

    function test_Refund_DirectSendSucceeds_NoPendingIncrease() public {
        // alice is an EOA — direct send works, pendingRefunds stays at 0.
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);

        assertEq(house.pendingRefunds(alice), 0);
    }

    function test_WithdrawRefund_RevertsWhenNoBalance() public {
        vm.expectRevert("No refund available");
        vm.prank(alice);
        house.withdrawRefund();
    }

    function test_PostTransferEscrowCheck_ERC721Liar() public {
        NoopERC721 liar = new NoopERC721();
        liar.setOwner(artist); // ownership check passes via isApprovedForAll
        vm.prank(artist);
        vm.expectRevert(PndAuctionHouse.EscrowFailed.selector);
        house.createAuction(
            1,
            address(liar),
            DURATION,
            RESERVE,
            payable(address(0)),
            0
        );
    }

}
