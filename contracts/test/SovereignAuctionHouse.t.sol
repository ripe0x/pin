// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SovereignAuctionHouse} from "../src/SovereignAuctionHouse.sol";
import {SovereignAuctionHouseFactory} from "../src/SovereignAuctionHouseFactory.sol";
import {ISovereignAuctionHouse} from "../src/ISovereignAuctionHouse.sol";
import {MockERC721} from "./MockERC721.sol";
import {NoopERC721} from "./NoopERC721.sol";
import {RevertingReceiver} from "./RevertingReceiver.sol";
import {NonReceivingBidder} from "./NonReceivingBidder.sol";

contract SovereignAuctionHouseTest is Test {
    SovereignAuctionHouse internal house;
    SovereignAuctionHouseFactory internal factory;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA01);
    address payable internal protocolTreasury = payable(address(0xFEE));

    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant DURATION = 24 hours;
    uint256 internal constant RESERVE = 1 ether;

    /// @dev OZ 5.6.1 ReentrancyGuard storage slot (REENTRANCY_GUARD_STORAGE).
    bytes32 internal constant REENTRANCY_GUARD_SLOT =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    function setUp() public {
        nft = new MockERC721();
        nft.mint(artist, TOKEN_ID);

        // Deploy implementation + factory (fully immutable, no admin).
        SovereignAuctionHouse impl = new SovereignAuctionHouse();
        factory = new SovereignAuctionHouseFactory(
            address(impl),
            protocolTreasury,
            0 // 0% fee, locked forever for this factory
        );

        // Artist deploys their auction house. createAuctionHouse uses
        // msg.sender as the artist, so prank.
        vm.prank(artist);
        address houseAddr = factory.createAuctionHouse();
        house = SovereignAuctionHouse(payable(houseAddr));

        // Artist approves their house to escrow the NFT.
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);

        // Fund bidders.
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ─── Helper ──────────────────────────────────────────────────────────

    function _readAuction(SovereignAuctionHouse h, uint256 id)
        internal
        view
        returns (ISovereignAuctionHouse.Auction memory a)
    {
        (
            uint256 tokenId,
            address tokenContract,
            uint64 firstBidTime,
            uint256 amount,
            uint256 reservePrice,
            address tokenOwner,
            uint64 endTime,
            address payable bidder,
            uint64 duration
        ) = h.auctions(id);
        a.tokenId = tokenId;
        a.tokenContract = tokenContract;
        a.firstBidTime = firstBidTime;
        a.amount = amount;
        a.reservePrice = reservePrice;
        a.tokenOwner = tokenOwner;
        a.endTime = endTime;
        a.bidder = bidder;
        a.duration = duration;
    }

    // ─── Initialization ──────────────────────────────────────────────────

    function test_Initialize_SetsState() public view {
        assertEq(house.owner(), artist);
        assertEq(house.feeRecipient(), protocolTreasury);
        assertEq(house.protocolFeeBps(), 0);
    }

    function test_Initialize_CannotBeCalledAgain() public {
        vm.expectRevert();
        house.initialize(artist, protocolTreasury, 0);
    }

    function test_Initialize_WarmsReentrancyGuardSlot() public view {
        // After initialize, the guard slot must be 1 (NOT_ENTERED) so the
        // first nonReentrant call pays SSTORE-from-1 instead of from-0.
        bytes32 v = vm.load(address(house), REENTRANCY_GUARD_SLOT);
        assertEq(uint256(v), 1);
    }

    function test_ReentrancyGuardSlot_DerivationMatchesOZ() public pure {
        bytes32 derived = keccak256(
            abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)
        ) & ~bytes32(uint256(0xff));
        assertEq(
            derived,
            0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00,
            "OZ ReentrancyGuard namespace label or derivation changed"
        );
    }

    /// @dev 2b: After a fresh clone is deployed, vm.load the OZ namespaced
    ///      slot and confirm it equals NOT_ENTERED (1).
    function test_ReentrancyGuardSlot_ReadsOneAfterInitialize() public {
        // Deploy a fresh clone via the factory for a different owner.
        vm.prank(bob);
        address freshHouseAddr = factory.createAuctionHouse();
        bytes32 v = vm.load(freshHouseAddr, REENTRANCY_GUARD_SLOT);
        assertEq(v, bytes32(uint256(1)));
    }

    function test_FactoryConstructor_RejectsFeeAboveCap() public {
        SovereignAuctionHouse impl = new SovereignAuctionHouse();
        vm.expectRevert("fee above cap");
        new SovereignAuctionHouseFactory(address(impl), protocolTreasury, 501);
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
        return house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE);
    }

    function test_CreateAuction_EscrowsNftAndStoresState() public {
        uint256 id = _createAuction();
        assertEq(nft.ownerOf(TOKEN_ID), address(house));
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.tokenId, TOKEN_ID);
        assertEq(a.tokenContract, address(nft));
        assertEq(a.amount, 0);
        assertEq(a.reservePrice, RESERVE);
        assertEq(a.tokenOwner, artist);
        assertEq(a.duration, uint64(DURATION));
        assertEq(a.firstBidTime, 0);
        assertEq(a.endTime, 0);
    }

    function test_CreateAuction_RejectsCallerThatIsNotHouseOwner() public {
        // Even if alice owns an NFT she can't list it in another artist's house.
        nft.mint(alice, 99);
        vm.prank(alice);
        nft.setApprovalForAll(address(house), true);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.createAuction(99, address(nft), DURATION, RESERVE);
    }

    function test_CreateAuction_RejectsArtistWhoDoesNotOwnTheNFT() public {
        // Artist owns the house but not this token -> ownerOf check still applies.
        nft.mint(alice, 42);
        vm.prank(artist);
        vm.expectRevert("Not token owner or approved");
        house.createAuction(42, address(nft), DURATION, RESERVE);
    }

    function test_CreateAuction_RejectsNonERC721() public {
        // Artist (an EOA) is not ERC721 — supportsInterface call will fail.
        vm.prank(artist);
        vm.expectRevert();
        house.createAuction(TOKEN_ID, artist, DURATION, RESERVE);
    }

    function test_CreateAuction_RejectsZeroDuration() public {
        vm.prank(artist);
        vm.expectRevert("duration zero");
        house.createAuction(TOKEN_ID, address(nft), 0, RESERVE);
    }

    function test_CreateAuction_RejectsAbsurdDuration() public {
        vm.prank(artist);
        vm.expectRevert("duration too large");
        house.createAuction(TOKEN_ID, address(nft), 365 days * 100 + 1, RESERVE);
    }

    // ─── Bid validation ──────────────────────────────────────────────────

    function test_Bid_RejectsBelowReserve() public {
        uint256 id = _createAuction();
        vm.expectRevert(SovereignAuctionHouse.BidBelowReserve.selector);
        vm.prank(alice);
        house.createBid{value: RESERVE - 1}(id);
    }

    function test_Bid_AcceptsAtReserve() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.amount, RESERVE);
        assertEq(a.bidder, alice);
        assertGt(a.firstBidTime, 0);
        assertEq(uint256(a.endTime), uint256(a.firstBidTime) + DURATION);
    }

    function test_Bid_RejectsBelowMinIncrement() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        // 5% increment over RESERVE = RESERVE * 1.05
        uint256 tooLow = RESERVE + (RESERVE * 499) / 10000; // < 5% bump
        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
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
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.amount, minNext);
        assertEq(a.bidder, bob);
    }

    /// Strict-greater logic with the 1-wei floor: an increment that rounds
    /// to zero in bps must still require at least previous + 1 wei.
    function test_Bid_RejectsExactMatchOnTinyPriorBid() public {
        // Use a fresh zero-reserve auction so we can have a 1-wei first bid.
        nft.mint(artist, 555);
        vm.prank(artist);
        uint256 id = house.createAuction(555, address(nft), DURATION, 0);

        vm.prank(alice);
        house.createBid{value: 1}(id); // amount = 1 wei

        // 5% of 1 = 0; floor pushes minNext to 2.
        // A bid of exactly 1 must revert.
        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
        vm.prank(bob);
        house.createBid{value: 1}(id);

        // Bid of 2 wei is the smallest valid next bid.
        vm.prank(bob);
        house.createBid{value: 2}(id);
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.amount, 2);
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
        vm.expectRevert(SovereignAuctionHouse.AuctionExpired.selector);
        vm.prank(bob);
        house.createBid{value: minNext}(id);
    }

    // ─── Late-bid time extension ─────────────────────────────────────────

    function test_LateBid_ExtendsEndTime() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);

        // Jump to inside the 15-minute buffer.
        vm.warp(block.timestamp + DURATION - 5 minutes);
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;

        vm.prank(bob);
        house.createBid{value: minNext}(id);

        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        // endTime should be at least block.timestamp + 15 minutes.
        assertGe(uint256(a.endTime), block.timestamp + 15 minutes);
    }

    function test_EarlyBid_DoesNotExtend() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        uint64 endTimeBefore = _readAuction(house, id).endTime;

        // Bid plenty of time before the buffer.
        vm.warp(block.timestamp + 1 hours);
        uint256 minNext = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNext}(id);

        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.endTime, endTimeBefore);
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
        vm.expectRevert(SovereignAuctionHouse.AuctionNotEnded.selector);
        house.endAuction(id);
    }

    function test_EndAuction_RejectsWithoutBids() public {
        uint256 id = _createAuction();
        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert(SovereignAuctionHouse.AuctionHasNoBids.selector);
        house.endAuction(id);
    }

    /// @dev Spin up a fresh fee-charging factory + house to test the fee path.
    ///      The default `house` is at 0% (locked). Per immutable design, a new
    ///      factory is the only way to vary protocol fee.
    function _newHouseWithFee(uint16 feeBps) internal returns (SovereignAuctionHouse h, uint256 nftTokenId) {
        SovereignAuctionHouse impl = new SovereignAuctionHouse();
        SovereignAuctionHouseFactory feeFactory = new SovereignAuctionHouseFactory(
            address(impl),
            protocolTreasury,
            feeBps
        );
        vm.prank(artist);
        h = SovereignAuctionHouse(payable(feeFactory.createAuctionHouse()));
        nftTokenId = uint256(uint160(address(h))) % 1_000_000 + 10_000;
        nft.mint(artist, nftTokenId);
        vm.prank(artist);
        nft.setApprovalForAll(address(h), true);
    }

    function test_EndAuction_PaysProtocolFee() public {
        (SovereignAuctionHouse h, uint256 tokenId) = _newHouseWithFee(250); // 2.5%

        vm.prank(artist);
        uint256 id = h.createAuction(tokenId, address(nft), DURATION, RESERVE);
        vm.prank(alice);
        h.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 feeRecipientBefore = protocolTreasury.balance;
        h.endAuction(id);

        uint256 expectedFee = (RESERVE * 250) / 10000;
        assertEq(protocolTreasury.balance - feeRecipientBefore, expectedFee);
        assertEq(artist.balance - sellerBefore, RESERVE - expectedFee);
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
        vm.expectRevert(SovereignAuctionHouse.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.cancelAuction(id);
    }

    function test_CancelAuction_RejectsNonOwner() public {
        uint256 id = _createAuction();
        vm.expectRevert("Not token owner");
        vm.prank(alice);
        house.cancelAuction(id);
    }

    function test_UpdateReserve_OnlyBeforeBids() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.setAuctionReservePrice(id, 2 ether);
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.reservePrice, 2 ether);

        vm.prank(alice);
        house.createBid{value: 2 ether}(id);

        vm.expectRevert(SovereignAuctionHouse.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.setAuctionReservePrice(id, 3 ether);
    }

    function test_UpdateReserve_RejectsNonOwner() public {
        uint256 id = _createAuction();
        vm.expectRevert("Not token owner");
        vm.prank(alice);
        house.setAuctionReservePrice(id, 2 ether);
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

    function test_Factory_PredictsHouseAddress() public {
        // Bob hasn't deployed yet; predict matches what createAuctionHouse will produce.
        address predicted = factory.predictHouseAddress(bob);
        vm.prank(bob);
        address actual = factory.createAuctionHouse();
        assertEq(predicted, actual);
    }

    function test_Factory_PredictDifferentForDifferentOwners() public {
        // Salt is keyed on the caller, so the prediction varies per address.
        address predA = factory.predictHouseAddress(alice);
        address predB = factory.predictHouseAddress(bob);
        assertTrue(predA != predB);
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

    // ─── getMinBidAmount tuple ───────────────────────────────────────────

    function test_GetMinBid_NonexistentReturnsFalse() public view {
        (bool exists, uint256 minBid) = house.getMinBidAmount(99999);
        assertFalse(exists);
        assertEq(minBid, 0);
    }

    function test_GetMinBid_PreBidReturnsReserve() public {
        uint256 id = _createAuction();
        (bool exists, uint256 minBid) = house.getMinBidAmount(id);
        assertTrue(exists);
        assertEq(minBid, RESERVE);
    }

    function test_GetMinBid_PostBidMatchesEnforcedFloor() public {
        // Tiny prior bid where 5% rounds to 0; getMinBidAmount must equal
        // the actual minimum createBid will accept.
        nft.mint(artist, 777);
        vm.prank(artist);
        uint256 id = house.createAuction(777, address(nft), DURATION, 0);

        vm.prank(alice);
        house.createBid{value: 1}(id);

        (bool exists, uint256 minBid) = house.getMinBidAmount(id);
        assertTrue(exists);
        assertEq(minBid, 2); // 1 + 1-wei floor

        // Confirm createBid rejects below this and accepts at this.
        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
        vm.prank(bob);
        house.createBid{value: minBid - 1}(id);

        vm.prank(bob);
        house.createBid{value: minBid}(id);
    }

    // ─── Bulk cancel ─────────────────────────────────────────────────────

    function _createBulkAuctions(uint256 count) internal returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = 100 + i;
            nft.mint(artist, tokenId);
            vm.prank(artist);
            ids[i] = house.createAuction(tokenId, address(nft), DURATION, RESERVE);
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

        vm.expectRevert(SovereignAuctionHouse.AuctionAlreadyStarted.selector);
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

        vm.expectRevert(SovereignAuctionHouse.AuctionDoesNotExist.selector);
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
            DURATION
        );

        assertEq(auctionIds.length, 3);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            assertEq(nft.ownerOf(tokenIds[i]), address(house));
            assertTrue(house.hasAuctionFor(address(nft), tokenIds[i]));
            ISovereignAuctionHouse.Auction memory a = _readAuction(house, auctionIds[i]);
            assertEq(a.reservePrice, RESERVE);
            assertEq(a.tokenOwner, artist);
        }
    }

    function test_BulkCreate_RejectsNonOwner() public {
        uint256[] memory tokenIds = _bulkMintTokens(2);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.bulkCreateAuctions(address(nft), tokenIds, RESERVE, DURATION);
    }

    function test_BulkCreate_RevertsIfArtistDoesntOwnOne() public {
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = 300;
        tokenIds[1] = 301;
        nft.mint(artist, 300);
        nft.mint(alice, 301); // artist doesn't own this one

        vm.expectRevert("Not token owner or approved");
        vm.prank(artist);
        house.bulkCreateAuctions(address(nft), tokenIds, RESERVE, DURATION);

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
            DURATION
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
    /// settlement.
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
        uint256 id = house.createAuction(555, address(nft), DURATION, 0);

        vm.expectRevert(SovereignAuctionHouse.BidMustBePositive.selector);
        vm.prank(alice);
        house.createBid{value: 0}(id);
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
        new SovereignAuctionHouseFactory(alice, protocolTreasury, 0);
    }

    /// #8 — Factory rejects address(0) explicitly with the impl-required check.
    function test_FactoryConstructor_RejectsZeroImpl() public {
        vm.expectRevert("impl required");
        new SovereignAuctionHouseFactory(address(0), protocolTreasury, 0);
    }

    /// Factory event includes immutable fee terms.
    function test_Factory_EmitsFeeTermsInEvent() public {
        // Topics: artist, house. Data: feeRecipient, protocolFeeBps.
        vm.expectEmit(true, false, false, true);
        emit SovereignAuctionHouseFactory.AuctionHouseCreated(
            bob,
            address(0), // we don't predict house addr; second indexed not strict
            protocolTreasury,
            0
        );
        vm.prank(bob);
        factory.createAuctionHouse();
    }

    // ─── Ownership lockdown ──────────────────────────────────────────────

    function test_Lock_TransferOwnershipReverts() public {
        vm.prank(artist);
        vm.expectRevert(SovereignAuctionHouse.OwnershipLocked.selector);
        house.transferOwnership(alice);
    }

    function test_Lock_RenounceOwnershipReverts() public {
        vm.prank(artist);
        vm.expectRevert(SovereignAuctionHouse.OwnershipLocked.selector);
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
        vm.expectRevert(SovereignAuctionHouse.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE);
    }

    function test_AfterCancel_CanRelist_ERC721() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        house.cancelAuction(id);

        // Now relist.
        vm.prank(artist);
        uint256 id2 = house.createAuction(TOKEN_ID, address(nft), DURATION, RESERVE);
        assertEq(id2, id + 1);
        assertTrue(house.hasAuctionFor(address(nft), TOKEN_ID));
    }

    function test_AfterSettle_CanRelistDifferentToken() public {
        uint256 id = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);

        nft.mint(artist, 1234);
        vm.prank(artist);
        uint256 id2 = house.createAuction(1234, address(nft), DURATION, RESERVE);
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
        vm.expectRevert(SovereignAuctionHouse.EscrowFailed.selector);
        house.createAuction(1, address(liar), DURATION, RESERVE);
    }

    // ─── Stuck-NFT recovery ──────────────────────────────────────────────

    function test_RecoverStuck_OwnerCanReclaim() public {
        // Plain transferFrom to the contract — no auction record.
        nft.mint(artist, 9001);
        vm.prank(artist);
        nft.transferFrom(artist, address(house), 9001);
        assertEq(nft.ownerOf(9001), address(house));
        assertFalse(house.hasAuctionFor(address(nft), 9001));

        // Owner reclaims to alice.
        vm.prank(artist);
        house.recoverStuckERC721(address(nft), 9001, alice);
        assertEq(nft.ownerOf(9001), alice);
    }

    function test_RecoverStuck_BlockedWhenAuctionExists() public {
        uint256 id = _createAuction();
        vm.prank(artist);
        vm.expectRevert(SovereignAuctionHouse.AuctionAlreadyExistsForToken.selector);
        house.recoverStuckERC721(address(nft), TOKEN_ID, artist);
        // Auction state unchanged.
        assertTrue(house.hasAuctionFor(address(nft), TOKEN_ID));
        assertEq(nft.ownerOf(TOKEN_ID), address(house));
        // Sanity: id reference still good.
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.tokenOwner, artist);
    }

    function test_RecoverStuck_RejectsNonOwner() public {
        nft.mint(artist, 9002);
        vm.prank(artist);
        nft.transferFrom(artist, address(house), 9002);

        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice);
        house.recoverStuckERC721(address(nft), 9002, alice);
    }

    function test_RecoverStuck_RejectsZeroAddress() public {
        nft.mint(artist, 9003);
        vm.prank(artist);
        nft.transferFrom(artist, address(house), 9003);

        vm.prank(artist);
        vm.expectRevert("to required");
        house.recoverStuckERC721(address(nft), 9003, address(0));
    }

    /// @dev 2c success path: recovery emits StuckERC721Recovered.
    function test_RecoverStuck_EmitsEvent() public {
        nft.mint(artist, 9100);
        vm.prank(artist);
        nft.transferFrom(artist, address(house), 9100);

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouse.StuckERC721Recovered(
            address(nft),
            9100,
            alice
        );
        vm.prank(artist);
        house.recoverStuckERC721(address(nft), 9100, alice);
        assertEq(nft.ownerOf(9100), alice);
    }

    /// @dev 2c clean-revert path: if the house never received the token, the
    ///      underlying ERC721 transferFrom reverts. We don't pin a selector.
    function test_RecoverStuck_RevertsWhenHouseDoesNotOwn() public {
        // Mint to alice; the house never receives it.
        nft.mint(alice, 9200);
        vm.prank(artist);
        vm.expectRevert();
        house.recoverStuckERC721(address(nft), 9200, artist);
    }

    // ─── Strict-bid 1-wei boundary ───────────────────────────────────────

    /// @dev 2d: Boundary cases for the bid increment + 1-wei floor.
    function test_Bid_StrictOneWeiBoundary() public {
        // Case A: large prior bid where bps math doesn't floor.
        // First bid b1 = RESERVE; b1 exact match must revert; b1 + 5% bps must succeed.
        uint256 idA = _createAuction();
        vm.prank(alice);
        house.createBid{value: RESERVE}(idA);

        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
        vm.prank(bob);
        house.createBid{value: RESERVE}(idA);

        uint256 minNextA = RESERVE + (RESERVE * 500) / 10000;
        vm.prank(bob);
        house.createBid{value: minNextA}(idA);

        // Case B: tiny prior bid where bps math floors to zero.
        // b1 = 1 wei; b1 + 1 = 2 wei must succeed (already covered, here we
        // also assert exact-match revert at b1 = 1).
        nft.mint(artist, 9300);
        vm.prank(artist);
        uint256 idB = house.createAuction(9300, address(nft), DURATION, 0);

        vm.prank(alice);
        house.createBid{value: 1}(idB);

        // 1 * 500 / 10000 == 0, so the floor must enforce minNext = 2.
        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
        vm.prank(bob);
        house.createBid{value: 1}(idB);

        vm.prank(bob);
        house.createBid{value: 2}(idB);
    }

    // ─── predictHouseAddress matches deployment ──────────────────────────

    /// @dev 2e: predictHouseAddress equals the address actually deployed.
    function test_PredictHouseAddress_MatchesActualDeployment() public {
        address someArtist = address(0xCAFE);
        address predicted = factory.predictHouseAddress(someArtist);
        vm.prank(someArtist);
        address actual = factory.createAuctionHouse();
        assertEq(predicted, actual);
    }

    // ─── getMinBidAmount fuzz parity ─────────────────────────────────────

    /// @dev 2f: getMinBidAmount must agree with the bid path's enforcement
    ///      across the full first-bid range.
    function testFuzz_GetMinBidAmount_MatchesCreateBidEnforcement(
        uint128 firstAmount
    ) public {
        vm.assume(firstAmount > 0 && firstAmount < 1_000_000 ether);

        // Fresh, low-reserve auction so any positive firstAmount clears reserve.
        nft.mint(artist, 9400);
        vm.prank(artist);
        uint256 id = house.createAuction(9400, address(nft), DURATION, 0);

        vm.deal(alice, uint256(firstAmount));
        vm.prank(alice);
        house.createBid{value: firstAmount}(id);

        (bool exists, uint256 minBid) = house.getMinBidAmount(id);
        assertTrue(exists);

        // Below the reported minimum must revert.
        vm.deal(bob, minBid);
        vm.expectRevert(SovereignAuctionHouse.BidBelowMinimum.selector);
        vm.prank(bob);
        house.createBid{value: minBid - 1}(id);

        // Exactly the reported minimum must succeed.
        vm.prank(bob);
        house.createBid{value: minBid}(id);

        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(a.amount, minBid);
        assertEq(a.bidder, bob);
    }

    // ─── First bid with duration < TIME_BUFFER triggers extension ────────

    /// @dev 2g: A first bid on a sub-buffer auction must extend immediately
    ///      so endTime ends up at block.timestamp + TIME_BUFFER, and both
    ///      firstBid + extended must be true on the AuctionBid event.
    function test_FirstBid_TriggersExtensionWhenDurationBelowBuffer() public {
        nft.mint(artist, 9500);
        uint256 shortDuration = 5 minutes; // < TIME_BUFFER (15 minutes)

        vm.prank(artist);
        uint256 id = house.createAuction(9500, address(nft), shortDuration, 0);

        // Expect both AuctionBid (firstBid=true, extended=true) and
        // AuctionEndTimeUpdated since the extension fires.
        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouse.AuctionBid(id, alice, 1, true, true);
        vm.expectEmit(true, false, false, true, address(house));
        emit ISovereignAuctionHouse.AuctionEndTimeUpdated(
            id,
            uint64(block.timestamp + house.TIME_BUFFER())
        );

        vm.prank(alice);
        house.createBid{value: 1}(id);

        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(uint256(a.endTime), block.timestamp + house.TIME_BUFFER());
    }

    // ─── MAX_DURATION boundary ───────────────────────────────────────────

    /// @dev 2h: duration == MAX_DURATION succeeds, duration > MAX_DURATION
    ///      reverts.
    function test_CreateAuction_MaxDurationBoundary() public {
        uint256 maxDuration = 365 days * 100;

        // Allowed: exactly MAX_DURATION.
        nft.mint(artist, 9600);
        vm.prank(artist);
        uint256 id = house.createAuction(9600, address(nft), maxDuration, RESERVE);
        ISovereignAuctionHouse.Auction memory a = _readAuction(house, id);
        assertEq(uint256(a.duration), maxDuration);

        // Disallowed: MAX_DURATION + 1.
        nft.mint(artist, 9601);
        vm.prank(artist);
        vm.expectRevert("duration too large");
        house.createAuction(9601, address(nft), maxDuration + 1, RESERVE);
    }
}
