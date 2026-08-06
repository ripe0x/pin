// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IMinter} from "../../../src/surface/interfaces/IMinter.sol";
import {AntonParams} from "../../../src/surface/works/anton/AntonParams.sol";
import {AntonMinter} from "../../../src/surface/works/anton/AntonMinter.sol";

/// @dev Stand-in Surface collection: ERC721 with sequential mintTo gated on an
///      authorized minter set, plus the owner/admin reads companions use.
contract MockSurface is ERC721 {
    mapping(address => bool) public isMinter;
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
            _mint(to, firstTokenId + i);
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
        params = new AntonParams(10, 19, 2);
        minter = new AntonMinter(address(col), address(params), PRICE, 0, 0, artist);
        col.setMinter(address(minter), true);
    }

    function test_typedMint_mints_writesParams_accruesPayout() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(3, 5, 1, true);

        assertEq(col.ownerOf(1), buyer);
        (bool set, uint8 p, uint8 s, uint8 t, bool bg) = params.paramsOf(address(col), 1);
        assertTrue(set);
        assertEq(p, 3);
        assertEq(s, 5);
        assertEq(t, 1);
        assertTrue(bg);
        assertEq(minter.pendingWithdrawal(artist), PRICE);
        assertEq(minter.totalMinted(), 1);
    }

    function test_wrongPayment_reverts() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        minter.mint{value: PRICE - 1}(0, 0, 0, false);
    }

    function test_dataMint_decodesParams_giftTo() public {
        vm.deal(buyer, 1 ether);
        bytes memory data = abi.encode(uint8(9), uint8(18), uint8(0), false);
        vm.prank(buyer);
        minter.mint{value: PRICE}(gift, 1, address(0), data);

        assertEq(col.ownerOf(1), gift);
        (, uint8 p, uint8 s,,) = params.paramsOf(address(col), 1);
        assertEq(p, 9);
        assertEq(s, 18);
    }

    function test_dataMint_quantityNotOne_reverts() public {
        vm.deal(buyer, 1 ether);
        bytes memory data = abi.encode(uint8(0), uint8(0), uint8(0), false);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AntonMinter.QuantityMustBeOne.selector, 2));
        minter.mint{value: PRICE}(buyer, 2, address(0), data);
    }

    function test_outOfRangeParam_revertsWholeMint() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.PaletteOutOfRange.selector, 10, 10));
        minter.mint{value: PRICE}(10, 0, 0, false);
        // nothing minted
        vm.expectRevert();
        col.ownerOf(1);
    }

    function test_mintWindow_enforced() public {
        vm.prank(artist);
        minter.setMintWindow(uint64(block.timestamp + 100), 0);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(IMinter.MintNotStarted.selector);
        minter.mint{value: PRICE}(0, 0, 0, false);
    }

    function test_withdraw_paysArtist() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        minter.mint{value: PRICE}(0, 0, 0, false);
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
        minter.mint{value: PRICE}(1, 1, 0, false);

        vm.prank(buyer);
        params.setParams(address(col), 1, 7, 2, 1, true);
        (, uint8 p,,,) = params.paramsOf(address(col), 1);
        assertEq(p, 7);
    }
}
