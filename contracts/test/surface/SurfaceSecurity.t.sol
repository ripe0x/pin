// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockMinter} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {InitParams} from "../../src/surface/SurfaceTypes.sol";

/// @dev Access-control matrix and the double-init / implementation-cannot-
///      be-initialized guarantees. Reentrancy and payment-conservation
///      coverage moves to the Phase 2 minter suite: with hooks and value
///      custody gone, the token's mint path makes no external calls.
contract SurfaceSecurityTest is SurfaceBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ════════════════════════════════════════════════════════════════════
    // Access control matrix: every owner-or-admin / minter-gated /
    // approval-gated function, called by a wrong caller (neither owner nor
    // admin), must revert NotAuthorized.
    // ════════════════════════════════════════════════════════════════════

    function test_accessControl_onlyOwnerFunctions() public {
        Surface c = _collection(_freeConfig());
        bytes memory unauth = abi.encodeWithSelector(ISurfaceCore.NotAuthorized.selector);

        vm.startPrank(stranger);

        vm.expectRevert(unauth);
        c.setRenderer(makeAddr("r"));

        vm.expectRevert(unauth);
        c.setMinter(makeAddr("m"), true);

        vm.expectRevert(unauth);
        c.setRoyalty(100, stranger);

        vm.expectRevert(unauth);
        c.setSupplyCap(1);

        vm.expectRevert(unauth);
        c.lockSupply();

        vm.expectRevert(unauth);
        c.notifyMetadataUpdate(1, 1);

        vm.expectRevert(unauth);
        c.lockRenderer();

        vm.expectRevert(unauth);
        c.rescueStrayETH(stranger);

        vm.stopPrank();
    }

    function test_accessControl_minterGatedFunctions() public {
        Surface seq = _collection(_freeConfig());
        PooledSurface pooled = _pooled(_freeConfig());

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        seq.mintTo(stranger, 1);

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        pooled.mintToId(stranger, 1);
    }

    function test_accessControl_burnRequiresOwnerOrApproved() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.burn(1);

        // approved operator CAN burn
        vm.prank(collector);
        c.approve(stranger, 1);
        vm.prank(stranger);
        c.burn(1);
        assertEq(c.balanceOf(collector), 0);
    }

    function test_accessControl_burnRequiresExistingToken() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.burn(1);
    }

    // ════════════════════════════════════════════════════════════════════
    // Unauthorized mintTo / mintToId (each on its own form).
    // ════════════════════════════════════════════════════════════════════

    function test_unauthorizedMinter_cannotMintTo() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        c.mintTo(stranger, 1);
    }

    function test_unauthorizedMinter_cannotMintToId() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        vm.prank(stranger);
        c.mintToId(stranger, 1);
    }

    function test_revokedMinter_losesAccess() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        assertTrue(c.isMinter(address(minter)));

        vm.prank(artist);
        c.setMinter(address(minter), false);
        assertFalse(c.isMinter(address(minter)));

        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        minter.callMintTo(ISurface(address(c)), collector, 1);
    }

    function test_setMinter_rejectsZeroAddress() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroMinter.selector);
        vm.prank(artist);
        c.setMinter(address(0), true);
    }

    // ════════════════════════════════════════════════════════════════════
    // Double-init rejection + implementation cannot be initialized.
    // ════════════════════════════════════════════════════════════════════

    function test_confirm_doubleInitReverts() public {
        Surface c = _collection(_freeConfig());
        InitParams memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        c.initialize(p);
    }

    function test_confirm_implCannotBeInitialized() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        impl.initialize(p);
    }
}
