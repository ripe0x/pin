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
    bool public noopOutbound;

    function mint(address to, uint256 id, uint256 amount) external {
        _balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approved[msg.sender][operator] = approved;
    }

    function setBreakOutbound(bool value) external {
        breakOutbound = value;
    }

    /// @dev Silently skips the balance move instead of reverting, so a
    ///      caller checking only the revert reason would see a false success.
    function setNoopOutbound(bool value) external {
        noopOutbound = value;
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
        if (noopOutbound && msg.sender == from) return;
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

/// @dev Contract wallet that bids but always rejects ERC1155 delivery,
///      forcing a deferral that never resolves in the winner's favor. Its
///      own rejection cannot force a refund by itself: only unwindStuckLot,
///      after the retry to it also fails, credits its bid back.
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

/// @dev Models a seller-controlled ERC1155 collection with a backdoor: any
///      account the seller designates as `admin` can force-move a quantity
///      regardless of approval. Mirrors ClawbackERC721 in
///      SovereignAuctionHouseV2.t.sol, for the ERC1155 delivery path.
contract ClawbackERC1155 {
    mapping(address => mapping(uint256 => uint256)) internal _balanceOf;
    mapping(address => mapping(address => bool)) internal _approved;
    address public admin;

    function mint(address to, uint256 id, uint256 amount) external {
        _balanceOf[to][id] += amount;
    }

    function setAdmin(address admin_) external {
        admin = admin_;
    }

    function setApprovalForAll(address operator, bool approved) external {
        _approved[msg.sender][operator] = approved;
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

    /// @dev The backdoor: admin-only, bypasses approval. Still requires
    ///      `from` to currently hold the quantity, so it can only claw the
    ///      lot back once delivery has actually moved it to the winner.
    function forceTransfer(address from, address to, uint256 id, uint256 amount) external {
        require(msg.sender == admin, "not admin");
        require(_balanceOf[from][id] >= amount, "insufficient balance");
        _balanceOf[from][id] -= amount;
        _balanceOf[to][id] += amount;
    }
}

/// @dev Griefing vector from the audit: a bare contract that can bid, so it
///      becomes the recorded winner, but has no onERC1155Received hook and
///      no function through which anyone could invoke claimLot on its
///      behalf. Delivery to this contract can never succeed, by anyone,
///      which is exactly the case unwindStuckLot exists to resolve.
contract BareERC1155Bidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }
}

/// @dev fundsRecipient for the seller running the clawback in
///      ClawbackERC1155. Its receive() attempts to force the quantity from
///      the winner back to the auction house. Because it is a contract, the
///      new payout rule never calls it: settlement credits it to
///      pendingRefunds instead of pushing, so this callback is unreachable
///      from settlement regardless of timing.
contract ClawbackRecipient1155 {
    ClawbackERC1155 public token;
    address public house;
    uint256 public tokenId;
    uint256 public quantity;
    address public winner;
    bool public attempted;
    bool public succeeded;

    function configure(ClawbackERC1155 token_, address house_, uint256 tokenId_, uint256 quantity_, address winner_)
        external
    {
        token = token_;
        house = house_;
        tokenId = tokenId_;
        quantity = quantity_;
        winner = winner_;
    }

    receive() external payable {
        attempted = true;
        try token.forceTransfer(winner, house, tokenId, quantity) {
            succeeded = true;
        } catch {}
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

    /// @dev No ETH is ever stranded: whatever the house holds must equal the
    ///      sum of pendingRefunds for every account a test touched.
    function _assertConserved(address[] memory touched) internal view {
        uint256 sum;
        for (uint256 i; i < touched.length; ++i) {
            sum += house.pendingRefunds(touched[i]);
        }
        assertEq(address(house).balance, sum, "ETH conservation invariant violated");
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
        assertEq(address(house).balance, 0);
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
    ///      contract-code bidder, is no longer special-cased: delivery is
    ///      attempted the same way regardless, and a bidder that cannot
    ///      accept the transfer only defers its own delivery. The seller is
    ///      not paid until delivery actually succeeds.
    function test_ContractCodeOnBidderNoLongerBlocksSettlement() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);

        // Models a bidder adding delegated EIP-7702 code after it bid.
        vm.etch(alice, hex"00");
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid while delivery is deferred");
        assertTrue(house.pendingDelivery(auctionId));
    }

    function test_BrokenDeliveryDefersLotAndPaysNobodyUntilClaim() public {
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
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertEq(bad.balanceOf(address(house), TOKEN_ID), QUANTITY);
        assertTrue(house.pendingDelivery(auctionId));
        (bool active,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertTrue(active);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC1155(address(bad), TOKEN_ID, QUANTITY, artist);

        bad.setBreakOutbound(false);
        uint256 fee = (RESERVE * 250) / 10_000;
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(bad.balanceOf(alice, TOKEN_ID), QUANTITY);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once claimLot succeeds");
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
    ///      refunded; the seller is paid only once the winner redirects its
    ///      own claim to a working EOA.
    function test_RejectingContractWinnerIsDeferredThenClaimsToRedirect() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        RejectingERC1155Bidder bidder = new RejectingERC1155Bidder();
        vm.deal(address(bidder), RESERVE);
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(token.balanceOf(address(house), TOKEN_ID), QUANTITY);

        uint256 fee = (RESERVE * 250) / 10_000;
        bidder.claim(address(house), auctionId, carol);
        assertEq(token.balanceOf(carol, TOKEN_ID), QUANTITY);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once the redirect succeeds");
    }

    function test_UnsolicitedSafeTransferIsRejected() public {
        vm.expectRevert(SovereignAuctionHouseV2.EscrowFailed.selector);
        vm.prank(artist);
        token.safeTransferFrom(artist, address(house), TOKEN_ID, 1, "");
    }

    /// @dev Paused delivery defers the lot and pays nobody; the seller is
    ///      paid once the winner claims after unpausing.
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
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertTrue(house.pendingDelivery(auctionId));

        vm.expectRevert();
        vm.prank(alice);
        house.claimLot(auctionId, address(0));

        paused.unpause();
        uint256 fee = (RESERVE * 250) / 10_000;
        vm.prank(alice);
        house.claimLot(auctionId, address(0));
        assertEq(paused.balanceOf(alice, TOKEN_ID), QUANTITY);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid once claimLot succeeds");
    }

    /// @dev If the collection unpauses before PENDING_DELIVERY_TIMEOUT but no
    ///      one claims within the window, unwindStuckLot's retry to the
    ///      recorded winner succeeds and finalizes the sale normally
    ///      (LotClaimed, not LotUnwound): the lot goes to the winner and the
    ///      seller is paid at that moment.
    function test_UnwindStuckLotRetriesWinnerDeliveryBeforeUnwinding() public {
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
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        // Unpaused before the timeout, but no one claims within the window.
        paused.unpause();
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;

        vm.expectEmit(true, true, true, false, address(house));
        emit ISovereignAuctionHouseV2.LotClaimed(auctionId, alice, alice);
        house.unwindStuckLot(auctionId);

        assertEq(paused.balanceOf(alice, TOKEN_ID), QUANTITY, "the winner received the lot, not the seller");
        assertEq(paused.balanceOf(artist, TOKEN_ID), 0);
        assertEq(artist.balance - sellerBefore, RESERVE - fee, "the seller is paid now that delivery succeeded");
        assertFalse(house.pendingDelivery(auctionId));
        (bool exists,) = house.getAuctionFor(address(paused), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");
    }

    /// @dev A winner that always rejects delivery (RejectingERC1155Bidder)
    ///      is still failing after PENDING_DELIVERY_TIMEOUT: unwindStuckLot's
    ///      retry fails the same way claimLot did, so the sale unwinds. The
    ///      winner's full bid is credited for withdrawal and the seller
    ///      (an ordinary EOA) gets the lot back; the seller is never paid.
    function test_UnwindStuckLotRefundsWinnerAndReturnsLotToSeller() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        RejectingERC1155Bidder bidder = new RejectingERC1155Bidder();
        vm.deal(address(bidder), RESERVE);
        bidder.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(auctionId);
        assertTrue(house.pendingDelivery(auctionId));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        uint256 sellerBefore = artist.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotUnwound(auctionId, address(bidder), RESERVE, artist);
        house.unwindStuckLot(auctionId);

        assertEq(token.balanceOf(artist, TOKEN_ID), 10, "the lot returns to the seller in full");
        assertEq(artist.balance, sellerBefore, "the seller is never paid ETH for this auction");
        assertEq(treasury.balance, treasuryBefore, "the protocol is never paid for this auction");
        assertEq(house.pendingRefunds(address(bidder)), RESERVE, "the winner's full bid is credited");
        assertFalse(house.pendingDelivery(auctionId));
        assertFalse(house.pendingReturn(auctionId));
        (bool exists,) = house.getAuctionFor(address(token), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");

        address[] memory touched = new address[](1);
        touched[0] = address(bidder);
        _assertConserved(touched);
    }

    /// @dev create1155Auction's listing expiry is stored, rejects bids once
    ///      passed, and expireAuction returns the lot to the tokenOwner.
    function test_Create1155AuctionSetsListingExpiryAndExpires() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, expiry);
        assertEq(house.listingExpiry(auctionId), expiry);

        vm.warp(expiry);
        vm.expectRevert(SovereignAuctionHouseV2.AuctionExpired.selector);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);

        house.expireAuction(auctionId);
        assertEq(token.balanceOf(artist, TOKEN_ID), 10);
    }

    /// @dev Audit High (CWE-367) regression, ERC1155 path, closed by the
    ///      deliver-first, credit-not-push payout rule: a seller-controlled
    ///      collection's admin backdoor can only claw the quantity back
    ///      through its fundsRecipient's payout callback, and since that
    ///      recipient is a contract, settlement never calls it at all.
    function test_ClawbackNeverRunsBecauseContractRecipientIsCreditedNotPushed() public {
        ClawbackERC1155 bad = new ClawbackERC1155();
        bad.mint(artist, TOKEN_ID, QUANTITY);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(bad), QUANTITY, DURATION, RESERVE, 0);

        ClawbackRecipient1155 recipient = new ClawbackRecipient1155();
        bad.setAdmin(address(recipient));
        recipient.configure(bad, address(house), TOKEN_ID, QUANTITY, alice);
        vm.prank(artist);
        house.setAuctionFundsRecipient(auctionId, payable(address(recipient)));

        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(auctionId);

        // The payout callback never fired: the recipient is a contract, so
        // settlement credited it instead of calling it.
        assertFalse(recipient.attempted());
        assertFalse(recipient.succeeded());

        assertEq(bad.balanceOf(alice, TOKEN_ID), QUANTITY);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists);

        uint256 fee = (RESERVE * 250) / 10_000;
        assertEq(house.pendingRefunds(address(recipient)), RESERVE - fee);

        // The owner cannot pull anything out through stuck-token recovery:
        // the house's balance for this id is zero, so any attempted amount
        // reverts.
        vm.expectRevert();
        vm.prank(artist);
        house.recoverStuckERC1155(address(bad), TOKEN_ID, QUANTITY, artist);

        address[] memory touched = new address[](2);
        touched[0] = treasury;
        touched[1] = address(recipient);
        _assertConserved(touched);
    }

    /// @dev Audit finding: an unprivileged attacker could bid on an ERC1155
    ///      lot with a bare contract that has no onERC1155Received and no
    ///      way to call claimLot. Delivery to that contract can never
    ///      succeed, permissionlessly or otherwise, so it is exactly the
    ///      genuinely-undeliverable case unwindStuckLot exists to resolve:
    ///      after PENDING_DELIVERY_TIMEOUT the griefer's own bid is credited
    ///      back to it (nobody needs to ban it or single it out) and the
    ///      seller's tokenId is relistable. The seller is never paid.
    function test_BareContractGriefingResolvedByUnwind() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        BareERC1155Bidder griefer = new BareERC1155Bidder();
        vm.deal(address(griefer), RESERVE);
        griefer.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        house.endAuction(auctionId);
        assertEq(artist.balance, sellerBefore, "the seller is not paid on a deferred delivery");
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), uint64(block.timestamp));

        // The winner cannot claim (no way to call claimLot), and a
        // permissionless claim-to-winner also cannot succeed: the griefer
        // contract has no onERC1155Received hook.
        vm.expectRevert();
        house.claimLot(auctionId, address(0));

        // Unwind is blocked before the timeout.
        vm.expectRevert(SovereignAuctionHouseV2.UnwindTooEarly.selector);
        house.unwindStuckLot(auctionId);

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        // Anyone may trigger the unwind; no special role is required.
        house.unwindStuckLot(auctionId);
        assertEq(token.balanceOf(artist, TOKEN_ID), 10);
        assertEq(artist.balance, sellerBefore, "the seller is never paid ETH for this auction");
        assertEq(house.pendingRefunds(address(griefer)), RESERVE, "the griefer's own bid is credited back to it");
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), 0);

        // _auctionIdByToken is cleared, so the tokenId can be relisted.
        (bool exists,) = house.getAuctionFor(address(token), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");
        vm.prank(artist);
        house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
    }

    /// @dev Below the doubled headroom guard, unwindStuckLot must revert
    ///      InsufficientGas rather than let a gas-starved retry or return
    ///      attempt run under-stipend and be misclassified as a genuine
    ///      delivery failure.
    function test_UnwindStuckLotRevertsWhenGasBelowDoubleDeliveryHeadroom() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        BareERC1155Bidder griefer = new BareERC1155Bidder();
        vm.deal(address(griefer), RESERVE);
        griefer.bid{value: RESERVE}(address(house), auctionId);
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

    /// @dev recoverStuckERC1155 on a genuinely stuck balance (no auction
    ///      record for the id) succeeds and emits StuckERC1155Recovered.
    ///      Balance is seeded via a mock whose mint() sets state directly, the
    ///      1155 equivalent of a plain, hook-free transfer landing on the
    ///      house with no auction record.
    function test_RecoverStuckERC1155_EmitsEventOnSuccess() public {
        MutableERC1155 stray = new MutableERC1155();
        stray.mint(address(house), TOKEN_ID, QUANTITY);
        assertEq(stray.balanceOf(address(house), TOKEN_ID), QUANTITY);

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.StuckERC1155Recovered(address(stray), TOKEN_ID, QUANTITY, alice);
        vm.prank(artist);
        house.recoverStuckERC1155(address(stray), TOKEN_ID, QUANTITY, alice);

        assertEq(stray.balanceOf(alice, TOKEN_ID), QUANTITY);
        assertEq(stray.balanceOf(address(house), TOKEN_ID), 0);
    }

    /// @dev A collection whose safeTransferFrom silently no-ops (no revert,
    ///      balance unchanged) must not be mistaken for a successful
    ///      recovery: recoverStuckERC1155 verifies the recipient's balance
    ///      actually increased and reverts DeliveryFailed otherwise.
    function test_RecoverStuckERC1155_RevertsDeliveryFailedOnSilentNoop() public {
        MutableERC1155 bad = new MutableERC1155();
        bad.mint(address(house), TOKEN_ID, QUANTITY);
        bad.setNoopOutbound(true);

        vm.expectRevert(SovereignAuctionHouseV2.DeliveryFailed.selector);
        vm.prank(artist);
        house.recoverStuckERC1155(address(bad), TOKEN_ID, QUANTITY, alice);
    }
}
