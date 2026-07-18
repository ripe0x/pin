// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";

/// @dev Audit M-01 remediation. Pooled burn is minter-wide authority, so a
///      second minter could retire a token the first one backs and strand its
///      escrow. The pooled form now holds ONE minter at a time and can freeze
///      it (lockMinter), so that address can never be added, and a locked
///      backed collection has exactly one address that can ever burn. The lock
///      is available on the sequential form too; the one-at-a-time cap is not.
contract SurfaceMinterLimitTest is SurfaceBase {
    address internal minterA = makeAddr("minterA");
    address internal minterB = makeAddr("minterB");

    function _one(address m) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = m;
    }

    // ── pooled: one minter at a time ──────────────────────────────────────────

    function test_pooled_rejectsSecondMinter() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));
        vm.expectRevert(ISurfaceCore.TooManyMinters.selector);
        vm.prank(artist);
        c.setMinter(minterB, true);
    }

    function test_pooled_initRejectsTwoMinters() public {
        address[] memory two = new address[](2);
        two[0] = minterA;
        two[1] = minterB;
        vm.expectRevert(ISurfaceCore.TooManyMinters.selector);
        _pooledWithMinters(_freeConfig(), two);
    }

    function test_pooled_canSwapMinterBeforeLock() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));
        // one at a time, not one ever: revoke A, then B fits (until locked)
        vm.startPrank(artist);
        c.setMinter(minterA, false);
        c.setMinter(minterB, true);
        vm.stopPrank();
        assertFalse(c.isMinter(minterA));
        assertTrue(c.isMinter(minterB));
    }

    function test_pooled_redundantGrantDoesNotDriftCount() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));
        // re-granting the same minter is a no-op, so the count stays 1 and a
        // different minter is still refused — no drift-to-two via double grant
        vm.prank(artist);
        c.setMinter(minterA, true);
        vm.expectRevert(ISurfaceCore.TooManyMinters.selector);
        vm.prank(artist);
        c.setMinter(minterB, true);
    }

    /// @dev The exact attack the fix closes: pre-fix a second minter could burn
    ///      the first minter's backed token. Now it can't be authorized at all,
    ///      and unauthorized it can't burn.
    function test_pooled_secondMinterCannotBurnFirstMintersToken() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));

        vm.prank(minterA);
        c.mintToId(collector, 42, address(0), "");
        assertEq(c.ownerOf(42), collector);

        vm.expectRevert(ISurfaceCore.TooManyMinters.selector);
        vm.prank(artist);
        c.setMinter(minterB, true);

        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(minterB);
        c.burn(42);
        assertEq(c.ownerOf(42), collector, "backed token survives");
    }

    // ── lockMinter ────────────────────────────────────────────────────────────

    function test_lockMinter_freezesGrantsAndRevokes() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));

        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.MinterLocked();
        vm.prank(artist);
        c.lockMinter();
        assertTrue(c.isMinterLocked());

        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        vm.prank(artist);
        c.setMinter(minterA, false);

        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        vm.prank(artist);
        c.setMinter(minterB, true);
    }

    function test_lockMinter_lockedMinterStillMintsAndBurns() public {
        PooledSurface c = _pooledWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.lockMinter();

        // the frozen single minter is still fully operational (the Homage path)
        vm.startPrank(minterA);
        c.mintToId(collector, 7, address(0), "");
        c.burn(7);
        vm.stopPrank();
        assertEq(c.balanceOf(collector), 0);
    }

    function test_lockMinter_rejectsDoubleLock() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.startPrank(artist);
        c.lockMinter();
        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        c.lockMinter();
        vm.stopPrank();
    }

    function test_lockMinter_onlyOwnerOrAdmin() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.lockMinter();
    }

    // ── sequential: no cap, lock still available ──────────────────────────────

    function test_sequential_allowsManyMinters() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.setMinter(minterA, true);
        c.setMinter(minterB, true);
        c.setMinter(makeAddr("minterC"), true);
        vm.stopPrank();
        assertTrue(c.isMinter(minterA));
        assertTrue(c.isMinter(minterB));
    }

    function test_sequential_lockMinter_freezesTheSet() public {
        Surface c = _collectionWithMinters(_freeConfig(), _one(minterA));
        vm.prank(artist);
        c.lockMinter();
        vm.expectRevert(ISurfaceCore.MinterIsLocked.selector);
        vm.prank(artist);
        c.setMinter(minterB, true);
    }
}
