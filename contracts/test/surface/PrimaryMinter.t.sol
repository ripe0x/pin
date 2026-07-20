// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";

/// @notice Core-level primaryMinter lifecycle: the frontend-discovery pointer
///         a generic client reads to find a collection's intended mint
///         module. Factory-level wiring (createSurface/createSurfaceCustom/
///         createPooledSurface passing it through) is covered in
///         SurfaceFactory.t.sol; this file covers setMinter/setPrimaryMinter/
///         lockMinter interaction on an already-deployed collection.
contract PrimaryMinterTest is SurfaceBase {
    address internal minterA = makeAddr("minterA");
    address internal minterB = makeAddr("minterB");

    function _one(address m) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = m;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sequential: setPrimaryMinter
    // ─────────────────────────────────────────────────────────────────────────

    function test_setPrimaryMinter_repointsToAGrantedMinter() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.setMinter(minterB, true);

        vm.expectEmit(true, false, false, false, address(c));
        emit ISurfaceCore.PrimaryMinterSet(minterB);
        vm.prank(artist);
        c.setPrimaryMinter(minterB);
        assertEq(c.primaryMinter(), minterB);
    }

    function test_setPrimaryMinter_toZero_clears() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.setPrimaryMinter(minterA);
        assertEq(c.primaryMinter(), minterA);

        vm.prank(artist);
        c.setPrimaryMinter(address(0));
        assertEq(c.primaryMinter(), address(0));
    }

    function test_setPrimaryMinter_toUngrantedAddressReverts() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.expectRevert(ISurfaceCore.PrimaryMinterNotAuthorized.selector);
        vm.prank(artist);
        c.setPrimaryMinter(minterB); // never granted on this collection
    }

    function test_setPrimaryMinter_onlyOwnerOrAdmin() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setPrimaryMinter(minterA);
    }

    function test_setPrimaryMinter_adminMayRepoint() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        address admin = makeAddr("admin");
        vm.prank(artist);
        c.addAdmin(admin);

        vm.prank(admin);
        c.setPrimaryMinter(minterA);
        assertEq(c.primaryMinter(), minterA);
    }

    function test_setPrimaryMinter_pooledReverts_OnlySequential() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));
        vm.expectRevert(ISurfaceCore.OnlySequential.selector);
        vm.prank(artist);
        c.setPrimaryMinter(minterA);
    }

    function test_setPrimaryMinter_afterLockMinter_reverts() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.setPrimaryMinter(minterA);
        vm.prank(artist);
        c.lockMinter();

        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        vm.prank(artist);
        c.setPrimaryMinter(minterA); // repoint to the same value still reverts: the pointer is frozen
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sequential: setMinter revoke clears primary
    // ─────────────────────────────────────────────────────────────────────────

    function test_setMinter_revokingCurrentPrimary_clearsAndEmits() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.setPrimaryMinter(minterA);
        assertEq(c.primaryMinter(), minterA);

        vm.expectEmit(true, false, false, false, address(c));
        emit ISurfaceCore.PrimaryMinterSet(address(0));
        vm.prank(artist);
        c.setMinter(minterA, false);
        assertEq(c.primaryMinter(), address(0), "revoking the primary clears the pointer");
    }

    function test_setMinter_revokingANonPrimaryMinter_leavesPrimaryUntouched() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.setMinter(minterB, true);
        vm.prank(artist);
        c.setPrimaryMinter(minterA);

        vm.prank(artist);
        c.setMinter(minterB, false);
        assertEq(c.primaryMinter(), minterA, "revoking a different minter does not touch the pointer");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pooled: primary tracks the sole minter automatically
    // ─────────────────────────────────────────────────────────────────────────

    function test_pooled_grantingSoleMinter_setsPrimaryAutomatically() public {
        PooledSurface c = _pooled(_freeConfig());
        assertEq(c.primaryMinter(), address(0));

        vm.expectEmit(true, false, false, false, address(c));
        emit ISurfaceCore.PrimaryMinterSet(minterA);
        vm.prank(artist);
        c.setMinter(minterA, true);
        assertEq(c.primaryMinter(), minterA);
    }

    function test_pooled_revokingSoleMinter_clearsPrimary() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(minterA, true); // post-init grant: sets primary automatically
        assertEq(c.primaryMinter(), minterA);

        vm.prank(artist);
        c.setMinter(minterA, false);
        assertEq(c.primaryMinter(), address(0));
    }

    /// @dev Replacing the pooled minter (revoke old, grant new) moves the
    ///      primary pointer to the new minter before lockMinter is called;
    ///      once locked, setMinter itself reverts (existing coverage in
    ///      SurfaceMinterLimit.t.sol), so the primary is stable alongside the
    ///      rest of the frozen minter set.
    function test_pooled_replacingMinter_updatesPrimaryBeforeLock() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.startPrank(artist);
        c.setMinter(minterA, true); // post-init grant: sets primary automatically
        assertEq(c.primaryMinter(), minterA);

        c.setMinter(minterA, false);
        c.setMinter(minterB, true);
        vm.stopPrank();

        assertEq(c.primaryMinter(), minterB, "primary follows the replacement minter");

        vm.prank(artist);
        c.lockMinter();
        assertTrue(c.isMinterLocked());
        assertEq(c.primaryMinter(), minterB, "primary is stable once locked");

        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        vm.prank(artist);
        c.setMinter(minterB, false); // the locked minter set cannot change, so neither can the primary
    }
}
