// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {AntonParams} from "../../../src/surface/works/anton/AntonParams.sol";

/// @dev Stand-in collection: an ERC721 with a settable minter set, matching the
///      two reads AntonParams performs (ownerOf, isMinter).
contract MockCollection is ERC721 {
    mapping(address => bool) public isMinter;

    constructor() ERC721("Mock", "MOCK") {}

    function setMinter(address m, bool v) external {
        isMinter[m] = v;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract AntonParamsTest is Test {
    AntonParams params;
    MockCollection col;

    uint8 constant PALETTES = 10;
    uint8 constant TONES = 2;

    address minter = makeAddr("minter");
    address owner1 = makeAddr("owner1");
    address owner2 = makeAddr("owner2");
    address stranger = makeAddr("stranger");

    function setUp() public {
        params = new AntonParams(PALETTES, TONES);
        col = new MockCollection();
        col.setMinter(minter, true);
        col.mint(owner1, 1);
    }

    function test_initParams_byMinter_setsAndReads() public {
        vm.prank(minter);
        params.initParams(address(col), 1, 3, 1);

        (bool set, uint8 p, uint8 t) = params.paramsOf(address(col), 1);
        assertTrue(set);
        assertEq(p, 3);
        assertEq(t, 1);
    }

    function test_initParams_byNonMinter_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.NotMinter.selector, stranger));
        params.initParams(address(col), 1, 0, 0);
    }

    function test_initParams_twice_reverts() public {
        vm.prank(minter);
        params.initParams(address(col), 1, 0, 0);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.AlreadyInitialized.selector, address(col), 1));
        params.initParams(address(col), 1, 1, 1);
    }

    function test_setParams_byOwner_overwrites() public {
        vm.prank(minter);
        params.initParams(address(col), 1, 0, 0);

        vm.prank(owner1);
        params.setParams(address(col), 1, 9, 1);

        (, uint8 p, uint8 t) = params.paramsOf(address(col), 1);
        assertEq(p, 9);
        assertEq(t, 1);
    }

    function test_setParams_byNonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.NotTokenOwner.selector, stranger, owner1));
        params.setParams(address(col), 1, 0, 0);
    }

    function test_setParams_followsCurrentOwner_afterTransfer() public {
        vm.prank(owner1);
        col.transferFrom(owner1, owner2, 1);

        vm.prank(owner1);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.NotTokenOwner.selector, owner1, owner2));
        params.setParams(address(col), 1, 0, 0);

        vm.prank(owner2);
        params.setParams(address(col), 1, 2, 0);
        (bool set,,) = params.paramsOf(address(col), 1);
        assertTrue(set);
    }

    function test_write_outOfRange_reverts() public {
        vm.startPrank(minter);
        vm.expectRevert(abi.encodeWithSelector(AntonParams.PaletteOutOfRange.selector, PALETTES, PALETTES));
        params.initParams(address(col), 1, PALETTES, 0);

        vm.expectRevert(abi.encodeWithSelector(AntonParams.ToneOutOfRange.selector, TONES, TONES));
        params.initParams(address(col), 1, 0, TONES);
        vm.stopPrank();
    }

    function test_paramsOf_unset_returnsFalse() public view {
        (bool set,,) = params.paramsOf(address(col), 999);
        assertFalse(set);
    }
}
