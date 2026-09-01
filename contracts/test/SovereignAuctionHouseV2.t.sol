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

/// @dev Acts as a house owner with no receive/fallback, to exercise the
///      curator-fee credit-on-reject path at settlement.
contract RejectingHouseOwner {
    function deployHouse(SovereignAuctionHouseV2Factory factory) external returns (SovereignAuctionHouseV2) {
        return SovereignAuctionHouseV2(payable(factory.createAuctionHouse()));
    }

    function createAuction(
        SovereignAuctionHouseV2 house,
        uint256 tokenId,
        address tokenContract,
        uint256 duration,
        uint256 reservePrice,
        uint16 curatorFeeBps
    ) external returns (uint256) {
        return house.createAuction(tokenId, tokenContract, duration, reservePrice, curatorFeeBps);
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

        // Only the winner may claim.
        bad.setTransferMode(false, false);
        vm.expectRevert(SovereignAuctionHouseV2.NotWinner.selector);
        vm.prank(bob);
        house.claimLot(auctionId, address(0));

        // Winner claims once delivery works again.
        vm.prank(alice);
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

    /// @dev A consigned lot (house owner lists a third party's token) with a
    ///      nonzero protocol fee and curator fee splits the hammer price
    ///      three ways: protocol fee to feeRecipient, curator fee to
    ///      owner(), remainder to the artist's fundsRecipient.
    function test_CuratorFeeSplitsThreeWaysOnConsignedAuction() public {
        uint256 tokenId = TOKEN_ID + 100;
        nft.mint(creator, tokenId);
        vm.prank(creator);
        nft.setApprovalForAll(artist, true);
        vm.prank(creator);
        nft.setApprovalForAll(address(house), true);

        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenId, address(nft), DURATION, RESERVE, 1000);
        _bidAndEnd(auctionId, alice, RESERVE);

        uint256 treasuryBefore = treasury.balance;
        uint256 curatorBefore = artist.balance;
        uint256 creatorBefore = creator.balance;
        house.endAuction(auctionId);

        uint256 protocolFee = (RESERVE * 250) / 10_000;
        uint256 curatorFee = (RESERVE * 1000) / 10_000;
        uint256 sellerProceeds = RESERVE - protocolFee - curatorFee;

        assertEq(treasury.balance - treasuryBefore, protocolFee);
        assertEq(artist.balance - curatorBefore, curatorFee);
        assertEq(creator.balance - creatorBefore, sellerProceeds);
        assertEq(nft.ownerOf(tokenId), alice);
    }

    /// @dev protocolFeeBps + curatorFeeBps above the 5000bps combined cap
    ///      reverts at create; exactly the cap is accepted and the stored
    ///      curatorFeeBps is readable back via getAuction.
    function test_CuratorFeeCapEnforcedAtCreateAndStoredImmutably() public {
        uint256 overCapTokenId = TOKEN_ID + 200;
        nft.mint(artist, overCapTokenId);
        vm.prank(artist);
        vm.expectRevert(SovereignAuctionHouseV2.CuratorFeeTooHigh.selector);
        house.createAuction(overCapTokenId, address(nft), DURATION, RESERVE, 4751);

        uint256 atCapTokenId = TOKEN_ID + 201;
        nft.mint(artist, atCapTokenId);
        vm.prank(artist);
        uint256 auctionId = house.createAuction(atCapTokenId, address(nft), DURATION, RESERVE, 4750);
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionId);
        assertEq(a.curatorFeeBps, 4750);
    }

    /// @dev The consigned artist (tokenOwner, not the house owner) can still
    ///      cancel pre-bid and get the token back regardless of the curator
    ///      fee set on the listing.
    function test_ConsignedArtistCancelsPreBidAndRegainsToken() public {
        uint256 tokenId = TOKEN_ID + 300;
        nft.mint(creator, tokenId);
        vm.prank(creator);
        nft.setApprovalForAll(artist, true);
        vm.prank(creator);
        nft.setApprovalForAll(address(house), true);

        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenId, address(nft), DURATION, RESERVE, 1000);

        vm.prank(creator);
        house.cancelAuction(auctionId);
        assertEq(nft.ownerOf(tokenId), creator);
    }

    /// @dev A deferred delivery still pays the curator fee at endAuction; a
    ///      later claimLot only moves the token, no funds.
    function test_DeferredDeliveryStillPaysCuratorFeeAndClaimMovesNoFunds() public {
        PausableNFT paused = new PausableNFT();
        uint256 tokenId = TOKEN_ID + 400;
        paused.mint(creator, tokenId);
        vm.prank(creator);
        paused.setApprovalForAll(artist, true);
        vm.prank(creator);
        paused.setApprovalForAll(address(house), true);

        vm.prank(artist);
        uint256 auctionId = house.createAuction(tokenId, address(paused), DURATION, RESERVE, 1000);
        vm.prank(alice);
        house.createBid{value: RESERVE}(auctionId);
        paused.pause();
        vm.warp(block.timestamp + DURATION + 1);

        uint256 curatorBefore = artist.balance;
        house.endAuction(auctionId);
        uint256 curatorFee = (RESERVE * 1000) / 10_000;
        assertEq(artist.balance - curatorBefore, curatorFee);
        assertTrue(house.pendingDelivery(auctionId));

        paused.unpause();
        uint256 curatorBeforeClaim = artist.balance;
        uint256 creatorBeforeClaim = creator.balance;
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(artist.balance, curatorBeforeClaim);
        assertEq(creator.balance, creatorBeforeClaim);
        assertEq(paused.ownerOf(tokenId), alice);
    }

    /// @dev A curator (owner()) with no receive/fallback is credited its fee
    ///      through pendingRefunds instead of blocking settlement.
    function test_RejectingCuratorGetsCreditedNotBlocked() public {
        SovereignAuctionHouseV2 impl2 = new SovereignAuctionHouseV2();
        SovereignAuctionHouseV2Factory factory2 = new SovereignAuctionHouseV2Factory(address(impl2), treasury, 250);
        RejectingHouseOwner rejectingOwner = new RejectingHouseOwner();
        SovereignAuctionHouseV2 rejectHouse = rejectingOwner.deployHouse(factory2);

        MockERC721 nft2 = new MockERC721();
        nft2.mint(creator, TOKEN_ID);
        vm.prank(creator);
        nft2.setApprovalForAll(address(rejectingOwner), true);
        vm.prank(creator);
        nft2.setApprovalForAll(address(rejectHouse), true);

        uint256 auctionId =
            rejectingOwner.createAuction(rejectHouse, TOKEN_ID, address(nft2), DURATION, RESERVE, 1000);
        vm.prank(alice);
        rejectHouse.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 curatorFee = (RESERVE * 1000) / 10_000;
        rejectHouse.endAuction(auctionId);

        assertEq(rejectHouse.pendingRefunds(address(rejectingOwner)), curatorFee);
        assertEq(nft2.ownerOf(TOKEN_ID), alice);
    }

    /// @dev curatorFeeBps == 0 reproduces pre-curator-fee behavior exactly:
    ///      AuctionEnded reports a zero curator fee and the seller receives
    ///      gross minus the protocol fee, with no extra external call.
    function test_ZeroCuratorFeeMatchesPreExistingBehavior() public {
        uint256 auctionId = _create();
        _bidAndEnd(auctionId, alice, RESERVE);

        uint256 protocolFee = (RESERVE * 250) / 10_000;
        vm.expectEmit(true, false, false, true, address(house));
        emit ISovereignAuctionHouseV2.AuctionEnded(auctionId, artist, alice, RESERVE - protocolFee, protocolFee, 0);
        house.endAuction(auctionId);
    }

    /// @dev bulkCreateAuctions applies the same curatorFeeBps to every lot
    ///      in the batch.
    function test_BulkCreateAuctionsAppliesCuratorFeeToEveryLot() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = TOKEN_ID + 500;
        ids[1] = TOKEN_ID + 501;
        ids[2] = TOKEN_ID + 502;
        for (uint256 i; i < ids.length; ++i) {
            nft.mint(artist, ids[i]);
        }

        vm.prank(artist);
        uint256[] memory auctionIds = house.bulkCreateAuctions(address(nft), ids, RESERVE, DURATION, 750);

        for (uint256 i; i < auctionIds.length; ++i) {
            ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionIds[i]);
            assertEq(a.curatorFeeBps, 750);
        }
    }
}
