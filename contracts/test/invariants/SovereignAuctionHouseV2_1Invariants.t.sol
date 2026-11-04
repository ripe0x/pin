// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC1155Receiver} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155Receiver.sol";
import {SovereignAuctionHouseV2_1} from "../../src/SovereignAuctionHouseV2_1.sol";
import {SovereignAuctionHouseV2_1Factory} from "../../src/SovereignAuctionHouseV2_1Factory.sol";
import {ISovereignAuctionHouseV2} from "../../src/ISovereignAuctionHouseV2.sol";
import {PausableERC1155} from "../PausableERC1155.sol";

/// @dev Contract bidder whose acceptance of ERC1155 delivery the handler
///      switches on and off, modelling a winner that refuses delivery.
contract ToggleBidder {
    bool public accept;

    function setAccept(bool value) external {
        accept = value;
    }

    function bid(SovereignAuctionHouseV2_1 house, uint256 auctionId) external payable {
        house.createBid{value: msg.value}(auctionId);
    }

    function claim(SovereignAuctionHouseV2_1 house, uint256 auctionId, address to) external {
        house.claimLot(auctionId, to);
    }

    function withdraw(SovereignAuctionHouseV2_1 house) external {
        house.withdrawRefund();
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(accept, "refuse");
        return IERC1155Receiver.onERC1155Received.selector;
    }

    receive() external payable {}
}

/// @dev Drives one V2.1 house over a pausable ERC1155 collection with two
///      EOA bidders and one contract bidder that can refuse delivery. Every
///      listing uses a fresh token id with quantity 1, so the house's
///      balance of an id is 1 exactly while that id's auction record exists.
contract AuctionV2_1Handler is Test {
    SovereignAuctionHouseV2_1 public house;
    PausableERC1155 public token;
    ToggleBidder public toggle;
    address public seller;
    address public treasury;
    address public alice = address(0xA11);
    address public bob = address(0xB0B);

    uint256[] public ids; // auction ids; token id == auction id + 1
    bool public refundWhileTransferable;
    uint256 public refunds;
    uint256 public helds;

    constructor(SovereignAuctionHouseV2_1 house_, PausableERC1155 token_, address seller_, address treasury_) {
        house = house_;
        token = token_;
        seller = seller_;
        treasury = treasury_;
        toggle = new ToggleBidder();
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) internal view returns (bool ok, uint256 auctionId) {
        if (ids.length == 0) return (false, 0);
        return (true, ids[seed % ids.length]);
    }

    function list(uint256 durationSeed) external {
        if (token.paused() || ids.length >= 12) return;
        uint256 tokenId = house.nextAuctionId() + 1;
        token.mint(seller, tokenId, 1);
        vm.prank(seller);
        uint256 auctionId =
            house.create1155Auction(tokenId, address(token), 1, bound(durationSeed, 1 hours, 3 days), 0.1 ether, 0);
        ids.push(auctionId);
    }

    function bid(uint256 seed, uint256 actorSeed, uint256 amountSeed) external {
        (bool ok, uint256 auctionId) = _pick(seed);
        if (!ok) return;
        ISovereignAuctionHouseV2.Auction memory a = house.getAuction(auctionId);
        if (a.tokenOwner == address(0)) return;
        if (a.firstBidTime != 0 && block.timestamp >= a.endTime) return;
        uint256 min = a.amount == 0 ? a.reservePrice : a.amount + (a.amount * 500) / 10_000 + 1;
        uint256 amount = bound(amountSeed, min, min * 2);
        uint256 who = actorSeed % 3;
        if (who == 2) {
            vm.deal(address(this), amount);
            toggle.bid{value: amount}(house, auctionId);
        } else {
            address actor = who == 0 ? alice : bob;
            vm.deal(actor, amount);
            vm.prank(actor);
            house.createBid{value: amount}(auctionId);
        }
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 40 days));
    }

    function togglePause() external {
        if (token.paused()) token.unpause();
        else token.pause();
    }

    function toggleAccept() external {
        toggle.setAccept(!toggle.accept());
    }

    function end(uint256 seed) external {
        (bool ok, uint256 auctionId) = _pick(seed);
        if (!ok) return;
        try house.endAuction(auctionId) {
            if (house.heldForWinner(auctionId)) helds++;
        } catch {}
    }

    function claim(uint256 seed, bool redirect) external {
        (bool ok, uint256 auctionId) = _pick(seed);
        if (!ok) return;
        address winner = house.getAuction(auctionId).bidder;
        address to = redirect ? address(0xCA11) : address(0);
        if (winner == address(toggle)) {
            try toggle.claim(house, auctionId, to) {} catch {}
        } else {
            vm.prank(winner);
            try house.claimLot(auctionId, to) {} catch {}
        }
    }

    function unwind(uint256 seed) external {
        (bool ok, uint256 auctionId) = _pick(seed);
        if (!ok) return;
        address winner = house.getAuction(auctionId).bidder;
        bool pausedNow = token.paused();
        uint256 before = house.pendingRefunds(winner);
        try house.unwindStuckLot(auctionId) {
            if (house.pendingRefunds(winner) > before) {
                refunds++;
                // The collection's pause is the only way this lot can be
                // non-transferable, so a refund on an unpaused collection
                // would mean a winner-side refusal was refunded.
                if (!pausedNow) refundWhileTransferable = true;
            }
            if (house.heldForWinner(auctionId)) helds++;
        } catch {}
    }

    function returnLot(uint256 seed) external {
        (bool ok, uint256 auctionId) = _pick(seed);
        if (!ok) return;
        try house.returnUnwoundLot(auctionId) {} catch {}
    }

    function withdraw(uint256 actorSeed) external {
        uint256 who = actorSeed % 3;
        if (who == 2) {
            try toggle.withdraw(house) {} catch {}
        } else {
            vm.prank(who == 0 ? alice : bob);
            try house.withdrawRefund() {} catch {}
        }
    }
}

/// @title SovereignAuctionHouseV2_1Invariants
/// @notice Random-walk invariants for V2.1 settlement. Deep pass:
///           FOUNDRY_PROFILE=invariant forge test --match-path "test/invariants/*"
contract SovereignAuctionHouseV2_1Invariants is StdInvariant, Test {
    AuctionV2_1Handler internal handler;
    SovereignAuctionHouseV2_1 internal house;
    PausableERC1155 internal token;
    address internal seller = address(0x5E11);
    address payable internal treasury = payable(address(0xFEE));

    function setUp() public {
        SovereignAuctionHouseV2_1 impl = new SovereignAuctionHouseV2_1();
        SovereignAuctionHouseV2_1Factory factory = new SovereignAuctionHouseV2_1Factory(address(impl), treasury, 250);
        vm.prank(seller);
        house = SovereignAuctionHouseV2_1(payable(factory.createAuctionHouse()));
        token = new PausableERC1155();
        vm.prank(seller);
        token.setApprovalForAll(address(house), true);
        handler = new AuctionV2_1Handler(house, token, seller, treasury);
        targetContract(address(handler));
    }

    /// @dev ETH held == refunds owed + bids still escrowed. A bid is escrowed
    ///      while its auction is live or pendingDelivery; once the sale
    ///      settles (delivered or held) it has been paid out, and once it is
    ///      unwound it has moved into pendingRefunds.
    function invariant_EthConservation() public view {
        uint256 owed = house.pendingRefunds(handler.alice()) + house.pendingRefunds(handler.bob())
            + house.pendingRefunds(address(handler.toggle())) + house.pendingRefunds(seller)
            + house.pendingRefunds(treasury);
        uint256 escrowed;
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            ISovereignAuctionHouseV2.Auction memory a = house.getAuction(id);
            if (a.tokenOwner == address(0) || a.firstBidTime == 0) continue;
            if (house.heldForWinner(id) || house.pendingReturn(id)) continue;
            escrowed += a.amount;
        }
        assertEq(address(house).balance, owed + escrowed);
    }

    /// @dev Settlement states are mutually exclusive, and the lot is in the
    ///      house exactly while its auction record exists.
    function invariant_StatesExclusiveAndLotCustody() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            uint256 n = (house.heldForWinner(id) ? 1 : 0) + (house.pendingDelivery(id) ? 1 : 0)
                + (house.pendingReturn(id) ? 1 : 0);
            assertLe(n, 1, "two settlement states at once");
            bool exists = house.getAuction(id).tokenOwner != address(0);
            assertEq(token.balanceOf(address(house), id + 1), exists ? 1 : 0, "custody mismatch");
            assertEq(token.balanceOf(house.DELIVERY_PROBE_RECIPIENT(), id + 1), 0, "probe left a token behind");
        }
    }

    /// @dev A winner is refunded only while the lot cannot be transferred.
    function invariant_NoRefundWhileTransferable() public view {
        assertFalse(handler.refundWhileTransferable());
    }
}
