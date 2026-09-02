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
///      which is exactly the case reclaimStuckLot exists to resolve.
contract BareERC1155Bidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }
}

/// @dev fundsRecipient for the seller running the clawback in
///      ClawbackERC1155: its receive() callback fires during the settlement
///      payout and attempts to force the quantity from the winner back to
///      the auction house.
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

    /// @dev CWE-841 fix: a deferred lot's delivery failure can be temporary.
    ///      If the collection unpauses before PENDING_DELIVERY_TIMEOUT but no
    ///      one claims within the window, reclaimStuckLot retries delivery to
    ///      the recorded winner first and sends the lot there, not to the
    ///      seller.
    function test_ReclaimStuckLotRetriesWinnerDeliveryBeforeSellerFallback() public {
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

        vm.expectEmit(true, true, true, false, address(house));
        emit ISovereignAuctionHouseV2.LotClaimed(auctionId, alice, alice);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        // The winner received the lot, not the seller.
        assertEq(paused.balanceOf(alice, TOKEN_ID), QUANTITY);
        assertEq(paused.balanceOf(artist, TOKEN_ID), 0);
        assertFalse(house.pendingDelivery(auctionId));
        (bool exists,) = house.getAuctionFor(address(paused), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");
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

    /// @dev Audit High (CWE-367), ERC1155 path: a seller-controlled
    ///      collection could use its fundsRecipient's payout-receive
    ///      callback to claw the winning quantity back after delivery but
    ///      before cleanup, leaving the house holding an unlocked balance
    ///      the owner could then drain via recoverStuckERC1155 while the
    ///      seller kept the proceeds. endAuction now settles funds before
    ///      attempting delivery, so the callback fires while the quantity is
    ///      still escrowed and the backdoor's `from == winner` balance check
    ///      fails.
    function test_FundsBeforeDeliveryClosesPayoutCallbackClawback() public {
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

        // The payout callback ran, but the clawback attempt failed: the
        // quantity had not moved to the winner yet at that point.
        assertTrue(recipient.attempted());
        assertFalse(recipient.succeeded());

        // Delivery completed normally as the last step, and cleanup is
        // consistent with that outcome.
        assertEq(bad.balanceOf(alice, TOKEN_ID), QUANTITY);
        (bool exists,) = house.getAuctionFor(address(bad), TOKEN_ID);
        assertFalse(exists);

        // The must-hold invariant: there is no reachable state where the
        // house holds the lot's balance while the reverse index is cleared.
        bool houseHoldsLot = bad.balanceOf(address(house), TOKEN_ID) != 0;
        assertFalse(houseHoldsLot && !exists, "house holds an unlocked lot");

        // The owner cannot pull anything out through stuck-token recovery:
        // the house's balance for this id is zero, so any attempted amount
        // reverts.
        vm.expectRevert();
        vm.prank(artist);
        house.recoverStuckERC1155(address(bad), TOKEN_ID, QUANTITY, artist);
    }

    /// @dev Audit finding: an unprivileged attacker could bid on an ERC1155
    ///      lot with a bare contract that has no onERC1155Received and no
    ///      way to call claimLot, permanently freezing the seller's token for
    ///      the cost of the reserve, since claimLot was gated to the
    ///      recorded winner and recoverStuck* is blocked while the token's
    ///      _auctionIdByToken entry is set. Delivery to that contract can
    ///      never succeed, permissionlessly or otherwise, so the seller's
    ///      timeout reclaim is the escape hatch: after PENDING_DELIVERY_TIMEOUT
    ///      the seller gets the lot back and the tokenId is relistable. This
    ///      is the genuinely-undeliverable case for the CWE-841 fix:
    ///      reclaimStuckLot's retry to the winner fails the same way claimLot
    ///      does, so it falls through to the seller exactly as before.
    function test_BareContractGriefingResolvedBySellerReclaim() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
        BareERC1155Bidder griefer = new BareERC1155Bidder();
        vm.deal(address(griefer), RESERVE);
        griefer.bid{value: RESERVE}(address(house), auctionId);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBefore = artist.balance;
        uint256 fee = (RESERVE * 250) / 10_000;
        house.endAuction(auctionId);
        assertEq(artist.balance - sellerBefore, RESERVE - fee);
        assertTrue(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), uint64(block.timestamp));

        // The winner cannot claim (no way to call claimLot), and a
        // permissionless claim-to-winner also cannot succeed: the griefer
        // contract has no onERC1155Received hook.
        vm.expectRevert();
        house.claimLot(auctionId, address(0));

        // Reclaim is blocked before the timeout.
        vm.expectRevert(SovereignAuctionHouseV2.ReclaimTooEarly.selector);
        vm.prank(artist);
        house.reclaimStuckLot(auctionId);

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);

        // Only the tokenOwner (artist, the seller) may reclaim.
        vm.expectRevert("Not token owner");
        vm.prank(alice);
        house.reclaimStuckLot(auctionId);

        vm.prank(artist);
        house.reclaimStuckLot(auctionId);
        assertEq(token.balanceOf(artist, TOKEN_ID), 10);
        assertFalse(house.pendingDelivery(auctionId));
        assertEq(house.deliveryDeferredAt(auctionId), 0);

        // _auctionIdByToken is cleared, so the tokenId can be relisted.
        (bool exists,) = house.getAuctionFor(address(token), TOKEN_ID);
        assertFalse(exists, "tokenId must be relistable");
        vm.prank(artist);
        house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE, 0);
    }
}
