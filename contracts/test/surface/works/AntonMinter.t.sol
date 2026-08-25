// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IMinter} from "../../../src/surface/interfaces/IMinter.sol";
import {AntonParams} from "../../../src/surface/works/anton/AntonParams.sol";
import {AntonMinter} from "../../../src/surface/works/anton/AntonMinter.sol";

/// @dev Stand-in Surface collection: ERC721 with sequential mintTo gated on an
///      authorized minter set, a per-token seed, plus owner/admin reads.
contract MockSurface is ERC721 {
    mapping(address => bool) public isMinter;
    mapping(uint256 => bytes32) public tokenSeed;
    address public owner;
    uint256 public mintedEver;

    constructor(address owner_) ERC721("Mock", "MOCK") {
        owner = owner_;
    }

    function isAdmin(address) external pure returns (bool) {
        return false;
    }

    function setMinter(address m, bool v) external {
        isMinter[m] = v;
    }

    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId) {
        require(isMinter[msg.sender], "not minter");
        firstTokenId = mintedEver + 1;
        for (uint256 i = 0; i < quantity; i++) {
            uint256 id = firstTokenId + i;
            tokenSeed[id] = keccak256(abi.encode(id, block.prevrandao, address(this)));
            _mint(to, id);
        }
        mintedEver += quantity;
    }
}

contract AntonMinterTest is Test {
    AntonParams params;
    AntonMinter minter;
    MockSurface col;

    address artist = makeAddr("artist");
    address buyer = makeAddr("buyer");
    address gift = makeAddr("gift");
    uint256 constant PRICE = 0.05 ether;

    function setUp() public {
        col = new MockSurface(artist);
        params = new AntonParams(10, 2);
        minter = new AntonMinter(address(col), address(params), PRICE, 0, 0, artist);
        col.setMinter(address(minter), true);
    }

    function test_mint_drawsRandomParamsFromSeed_inRange() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(1);

        assertEq(col.ownerOf(1), buyer);
        (bool set, uint8 p, uint8 t) = params.paramsOf(address(col), 1);
        assertTrue(set);
        assertLt(p, 10);
        assertLt(t, 2);
        assertEq(minter.pendingWithdrawal(artist), PRICE);
        assertEq(minter.totalMinted(), 1);
    }

    function test_wrongPayment_reverts() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        minter.mint{value: PRICE - 1}(1);
    }

    function test_dataMint_giftTo() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(gift, 1, address(0), "");

        assertEq(col.ownerOf(1), gift);
        (bool set,,) = params.paramsOf(address(col), 1);
        assertTrue(set);
    }

    function test_batchMint_perTokenParams_payment() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE * 3}(3);

        assertEq(minter.totalMinted(), 3);
        assertEq(minter.pendingWithdrawal(artist), PRICE * 3);
        for (uint256 id = 1; id <= 3; id++) {
            assertEq(col.ownerOf(id), buyer);
            (bool set, uint8 p, uint8 t) = params.paramsOf(address(col), id);
            assertTrue(set);
            assertLt(p, 10);
            assertLt(t, 2);
        }
    }

    function test_batchMint_wrongPayment_reverts() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE * 3, PRICE * 2));
        minter.mint{value: PRICE * 2}(3);
    }

    function test_tooManyPerMint_reverts() public {
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AntonMinter.TooManyPerMint.selector, 20, 21));
        minter.mint{value: PRICE * 21}(21);
    }

    function test_zeroQuantity_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(IMinter.ZeroQuantity.selector);
        minter.mint(0);
    }

    function test_mintWindow_enforced() public {
        vm.prank(artist);
        minter.setMintWindow(uint64(block.timestamp + 100), 0);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(IMinter.MintNotStarted.selector);
        minter.mint{value: PRICE}(1);
    }

    function test_withdraw_paysArtist() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(1);
        uint256 before = artist.balance;
        minter.withdraw(artist);
        assertEq(artist.balance, before + PRICE);
    }

    function test_setPrice_auth() public {
        vm.prank(buyer);
        vm.expectRevert(AntonMinter.NotAuthorized.selector);
        minter.setPrice(1);

        vm.prank(artist);
        minter.setPrice(1 ether);
        assertEq(minter.price(), 1 ether);
    }

    function test_ownerCanRepickAfterMint() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(1);

        vm.prank(buyer);
        params.setParams(address(col), 1, 7, 1);
        (, uint8 p, uint8 t) = params.paramsOf(address(col), 1);
        assertEq(p, 7);
        assertEq(t, 1);
    }
}
