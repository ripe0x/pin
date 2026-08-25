// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/ERC1155.sol";
import {IERC1155Receiver} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155Receiver.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {MockERC721} from "./MockERC721.sol";

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

contract ERC1155BidProxy {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }
}

/// @dev `code.length == 0` during this constructor. The house must still
///      reject its bid, because the deployed contract could reject delivery.
contract ConstructorERC1155Bidder {
    constructor(address house, uint256 auctionId) payable {
        SovereignAuctionHouseV2(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
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

    function test_WholeLotSettlesToEoaWinnerAndPaysFundsRecipient() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE);
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
    }

    function test_SameHouseCanCreate721And1155Lots() public {
        vm.prank(artist);
        uint256 erc1155AuctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE);

        MockERC721 nft = new MockERC721();
        nft.mint(artist, 2);
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 erc721AuctionId = house.createAuction(2, address(nft), DURATION, RESERVE);

        (,,,,,,,,,, uint256 quantity1155, ISovereignAuctionHouseV2.TokenStandard standard1155) = house.auctions(erc1155AuctionId);
        (,,,,,,,,,, uint256 quantity721, ISovereignAuctionHouseV2.TokenStandard standard721) = house.auctions(erc721AuctionId);
        assertEq(quantity1155, QUANTITY);
        assertEq(uint8(standard1155), 1);
        assertEq(quantity721, 1);
        assertEq(uint8(standard721), 0);
    }

    function test_PostBidCodeCannotForce1155Refund() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);

        // Models a bidder adding delegated EIP-7702 code after it bid.
        vm.etch(alice, hex"00");
        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert(SovereignAuctionHouseV2.ContractBidderNotSupported.selector);
        house.endAuction(auctionId);

        assertEq(house.pendingRefunds(alice), 0);
        assertEq(token.balanceOf(address(house), TOKEN_ID), QUANTITY);
        (bool active,) = house.getAuctionFor(address(token), TOKEN_ID);
        assertTrue(active);
    }


    function test_BrokenDeliveryRefundsWinnerAndCanReturnLot() public {
        MutableERC1155 bad = new MutableERC1155();
        bad.mint(artist, TOKEN_ID, QUANTITY);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(bad), QUANTITY, DURATION, RESERVE);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(auctionId);
        bad.setBreakOutbound(true);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(auctionId);
        assertEq(house.pendingRefunds(alice), RESERVE);
        assertEq(bad.balanceOf(address(house), TOKEN_ID), QUANTITY);
        (bool active,) = house.getAuctionFor(address(bad), TOKEN_ID);
        (bool failed,) = house.getFailedAuctionFor(address(bad), TOKEN_ID);
        assertFalse(active);
        assertTrue(failed);

        bad.setBreakOutbound(false);
        house.claimFailedLot(auctionId);
        assertEq(bad.balanceOf(artist, TOKEN_ID), QUANTITY);
    }

    function test_ContractWalletBidsAreRejectedToPreventReceiverOptOut() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE);
        ERC1155BidProxy proxy = new ERC1155BidProxy();
        vm.deal(address(proxy), RESERVE);
        vm.expectRevert(SovereignAuctionHouseV2.ContractBidderNotSupported.selector);
        proxy.bid{value: RESERVE}(address(house), auctionId);
    }

    function test_UnsolicitedSafeTransferIsRejected() public {
        vm.expectRevert(SovereignAuctionHouseV2.EscrowFailed.selector);
        vm.prank(artist);
        token.safeTransferFrom(artist, address(house), TOKEN_ID, 1, "");
    }

    function test_ConstructorBidIsRejectedToPreventReceiverOptOut() public {
        vm.prank(artist);
        uint256 auctionId = house.create1155Auction(TOKEN_ID, address(token), QUANTITY, DURATION, RESERVE);
        vm.deal(alice, RESERVE);
        vm.expectRevert(SovereignAuctionHouseV2.ContractBidderNotSupported.selector);
        vm.startPrank(alice, alice);
        new ConstructorERC1155Bidder{value: RESERVE}(address(house), auctionId);
        vm.stopPrank();
    }
}
