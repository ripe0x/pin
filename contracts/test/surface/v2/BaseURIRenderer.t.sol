// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../src/surface/v2/Surface.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {BaseURIRenderer} from "../../../src/surface/v2/BaseURIRenderer.sol";

/// @notice Drives the real path for a 333-piece 1/1 collection: a Surface
///         clone whose minter is the artist's own wallet, metadata as one
///         folder, frozen by renouncing the collection.
contract BaseURIRendererTest is Test {
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    event BaseURISet(address indexed collection, string baseURI);

    CloneFactory internal factory;
    BaseURIRenderer internal renderer;

    address internal artist = makeAddr("artist");
    address internal stranger = makeAddr("stranger");

    string internal constant FOLDER = "ipfs://bafyfolder/";

    function setUp() public {
        factory = new CloneFactory(address(new Surface()), Surface.initialize.selector);
        renderer = new BaseURIRenderer();
    }

    function _collection(address renderer_, uint256 cap) internal returns (Surface) {
        return Surface(
            factory.create(
                abi.encodeCall(Surface.initialize, ("Rare II", "RARE2", artist, renderer_, cap, 500, artist, artist))
            )
        );
    }

    function test_fullLaunch_333() public {
        Surface c = _collection(address(renderer), 333);

        vm.prank(artist);
        uint256 gasBefore = gasleft();
        c.mintTo(artist, 333);
        emit log_named_uint("gas mintTo(333)", gasBefore - gasleft());
        assertEq(c.balanceOf(artist), 333);

        assertEq(c.tokenURI(1), "", "unset base is empty");

        vm.expectEmit(address(renderer));
        emit BaseURISet(address(c), FOLDER);
        vm.expectEmit(address(c));
        emit BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        renderer.setBaseURI(address(c), FOLDER);

        assertEq(c.tokenURI(1), "ipfs://bafyfolder/1.json");
        assertEq(c.tokenURI(333), "ipfs://bafyfolder/333.json");
        assertEq(c.contractURI(), "");

        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSignature("ExceedsCap(uint256,uint256)", 333, 334));
        c.mintTo(artist, 1);
    }

    function test_onlyCollectionOwner() public {
        Surface c = _collection(address(renderer), 0);
        vm.prank(stranger);
        vm.expectRevert(BaseURIRenderer.NotCollectionOwner.selector);
        renderer.setBaseURI(address(c), FOLDER);
    }

    function test_renounceFreezesBaseURI() public {
        Surface c = _collection(address(renderer), 0);
        vm.startPrank(artist);
        c.mintTo(artist, 1);
        renderer.setBaseURI(address(c), FOLDER);
        c.renounceOwnership();
        vm.expectRevert(BaseURIRenderer.NotCollectionOwner.selector);
        renderer.setBaseURI(address(c), "ipfs://swapped/");
        vm.stopPrank();
        assertEq(c.tokenURI(1), "ipfs://bafyfolder/1.json");
    }

    function test_authorityFollowsOwnershipTransfer() public {
        Surface c = _collection(address(renderer), 0);
        vm.prank(artist);
        c.transferOwnership(stranger);

        vm.prank(artist);
        vm.expectRevert(BaseURIRenderer.NotCollectionOwner.selector);
        renderer.setBaseURI(address(c), FOLDER);

        vm.prank(stranger);
        renderer.setBaseURI(address(c), FOLDER);
        assertEq(renderer.baseURIOf(address(c)), FOLDER);
    }

    /// Setting the base before switching renderers must not revert on the
    /// refresh (the collection only accepts it from its current renderer).
    function test_setBeforeSwitchingRenderer() public {
        BaseURIRenderer previous = new BaseURIRenderer();
        Surface c = _collection(address(previous), 0);
        vm.startPrank(artist);
        c.mintTo(artist, 1);
        renderer.setBaseURI(address(c), FOLDER);
        assertEq(c.tokenURI(1), "", "previous renderer still serves");
        c.setRenderer(address(renderer));
        vm.stopPrank();
        assertEq(c.tokenURI(1), "ipfs://bafyfolder/1.json");
    }

    function test_collectionsAreIsolated() public {
        Surface a = _collection(address(renderer), 0);
        Surface b = _collection(address(renderer), 0);
        vm.startPrank(artist);
        a.mintTo(artist, 1);
        b.mintTo(artist, 1);
        renderer.setBaseURI(address(a), FOLDER);
        vm.stopPrank();
        assertEq(a.tokenURI(1), "ipfs://bafyfolder/1.json");
        assertEq(b.tokenURI(1), "");
    }
}
