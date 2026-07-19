// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockRenderer} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";

/// @dev Admins: the owner may grant flat, full-access admin keys. An admin can
///      call every management function the owner can EXCEPT managing the admin
///      set (addAdmin/removeAdmin) and transferring ownership, which stay
///      owner-only.
contract SurfaceAdminTest is SurfaceBase {
    address internal admin = makeAddr("admin");

    bytes internal ownableUnauthAdmin = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", admin);
    bytes internal ownableUnauthStranger = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);

    // ── grant / revoke lifecycle ──────────────────────────────────────────────

    /// @dev The owner has always held every admin power; isAdmin says so.
    ///      External integrations gate on this view (MURI's registerContract),
    ///      so the owner must pass it without an explicit self-grant.
    function test_isAdmin_countsOwner() public {
        Surface c = _collection(_freeConfig());
        assertTrue(c.isAdmin(artist), "the owner is an admin");
        assertFalse(c.isAdmin(stranger), "a stranger is not");

        // Ownership transfer moves the implicit grant with it.
        address heir = makeAddr("heir");
        vm.prank(artist);
        c.transferOwnership(heir);
        vm.prank(heir);
        c.acceptOwnership();
        assertTrue(c.isAdmin(heir), "the new owner is an admin");
        assertFalse(c.isAdmin(artist), "the old owner is not");
    }

    function test_owner_grantsAndRevokesAdmin() public {
        Surface c = _collection(_freeConfig());
        assertFalse(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceCore.AdminSet(admin, true);
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceCore.AdminSet(admin, false);
        vm.prank(artist);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));
    }

    // ── addAdmin guards ───────────────────────────────────────────────────────

    function test_addAdmin_rejectsZeroAccount() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroAccount.selector);
        vm.prank(artist);
        c.addAdmin(address(0));
    }

    function test_addAdmin_rejectsAlreadyAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        vm.expectRevert(ISurfaceCore.AlreadyAdmin.selector);
        c.addAdmin(admin);
        vm.stopPrank();
    }

    /// @dev The owner is already an admin (isAdmin reads it live), so a
    ///      self-grant is refused: it would only mint an explicit key that
    ///      outlives ownership transfer, which is never what the caller means.
    function test_addAdmin_rejectsOwner() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.AlreadyAdmin.selector);
        vm.prank(artist);
        c.addAdmin(artist);
        assertFalse(c.isAdmin(stranger)); // sanity: nothing was granted
    }

    function test_addAdmin_onlyOwner_notStranger() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ownableUnauthStranger);
        vm.prank(stranger);
        c.addAdmin(stranger);
    }

    // ── removeAdmin guards ────────────────────────────────────────────────────

    function test_removeAdmin_rejectsNotAnAdmin() public {
        Surface c = _collection(_freeConfig());
        // never granted
        vm.expectRevert(ISurfaceCore.NotAnAdmin.selector);
        vm.prank(artist);
        c.removeAdmin(admin);
    }

    function test_removeAdmin_rejectsDoubleRemove() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.expectRevert(ISurfaceCore.NotAnAdmin.selector);
        c.removeAdmin(admin); // second remove has nothing to revoke
        vm.stopPrank();
    }

    function test_removeAdmin_rejectsUnrelatedCaller() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // a caller who is neither the owner nor the account itself is rejected
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.removeAdmin(admin);
    }

    function test_admin_canRenounceSelf() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        // an admin may drop its own key by passing its own address
        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceCore.AdminSet(admin, false);
        vm.prank(admin);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));

        // and having renounced, it can no longer manage
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(admin);
        c.setSupplyCap(0);
    }

    // ── admin grants are scoped to the granting owner ─────────────────────────

    /// @dev A grant made by one owner must not survive an ownership transfer: the new owner
    ///      starts with a clean slate and re-grants deliberately. Guards the collection-sale /
    ///      wallet-rotation case where a stale admin could otherwise redirect proceeds.
    function test_adminGrant_expiresOnOwnershipTransfer() public {
        Surface c = _collection(_freeConfig());
        address newOwner = makeAddr("newOwner");
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin), "granted under the original owner");

        // hand the collection to a new owner (Ownable2Step)
        vm.prank(artist);
        c.transferOwnership(newOwner);
        vm.prank(newOwner);
        c.acceptOwnership();

        // the old owner's admin grant no longer counts
        assertFalse(c.isAdmin(admin), "stale admin invalidated by the transfer");
        vm.prank(admin);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.setSupplyCap(0);

        // the new owner is an admin and can re-grant deliberately
        assertTrue(c.isAdmin(newOwner), "new owner is an admin");
        vm.prank(newOwner);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin), "re-granted under the new owner");
        vm.prank(admin);
        c.setSupplyCap(0); // now allowed
    }

    // ── pooled minter authority is owner-only ─────────────────────────────────

    /// @dev On a pooled (backed) collection the minter is load-bearing for solvency, so
    ///      swapping or locking it is owner-only — a delegated admin must not be able to
    ///      rotate the minter and strand another minter's backed escrow.
    function test_pooled_minterAuthority_isOwnerOnly() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin), "admin granted");

        // an admin CANNOT touch the pooled minter set
        vm.prank(admin);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.setMinter(makeAddr("rogueMinter"), true);
        vm.prank(admin);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.lockMinter();

        // the owner can
        address m = makeAddr("goodMinter");
        vm.prank(artist);
        c.setMinter(m, true);
        assertTrue(c.isMinter(m), "owner set the pooled minter");
        vm.prank(artist);
        c.lockMinter();
        assertTrue(c.isMinterLocked(), "owner locked the pooled minter");
    }

    /// @dev Sequential collections carry no backing, so an admin keeps minter authority —
    ///      the owner-only restriction is pooled-specific.
    function test_sequential_setMinter_allowsAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        address m = makeAddr("seqMinter");
        vm.prank(admin);
        c.setMinter(m, true); // sequential: admin retains minter authority
        assertTrue(c.isMinter(m), "admin set a sequential minter");
    }

    function test_admin_canRunEveryManagementFunction() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        _mintTo(c, collector, 1);

        address newRenderer = address(new MockRenderer());
        vm.startPrank(admin);
        c.setRoyalty(250, makeAddr("royalty"));
        c.setSupplyCap(100);
        c.setRenderer(newRenderer);
        c.setMinter(makeAddr("minter"), true);
        c.notifyMetadataUpdate(1, 1);
        c.lockSupply();
        c.lockRenderer();
        vm.stopPrank();

        assertTrue(c.isMinter(makeAddr("minter")));
        assertTrue(c.isSupplyLocked());
        assertTrue(c.isRendererLocked());
    }

    // ── the two owner-only exceptions ─────────────────────────────────────────

    function test_admin_cannotAddOrRemovePeers() public {
        Surface c = _collection(_freeConfig());
        address admin2 = makeAddr("admin2");
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.addAdmin(admin2);
        vm.stopPrank();

        // an admin cannot grant new admins (addAdmin stays owner-only)...
        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.addAdmin(makeAddr("other"));

        // ...nor revoke a PEER: removeAdmin allows only the owner or the
        // account itself, so an admin removing a different admin is rejected.
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(admin);
        c.removeAdmin(admin2);
    }

    function test_admin_cannotTransferOwnership() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.transferOwnership(admin);
    }

    // ── revocation + non-admins ───────────────────────────────────────────────

    function test_revokedAdmin_losesAccess() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.stopPrank();

        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(admin);
        c.setSupplyCap(0);
    }

    function test_nonAdmin_cannotManage() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setSupplyCap(0);
    }

    function test_owner_remainsAuthorizedAlongsideAdmins() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // owner is an implicit admin and keeps full access
        vm.prank(artist);
        c.setSupplyCap(10);
        (, uint256 minted) = c.config();
        assertEq(minted, 0);
    }

    // ── renderer lock still supreme over admins ──────────────────────────────

    function test_lockRenderer_blocksAdminSwap() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // an admin may lock (full access), and the lock then blocks everyone —
        // including admins — from swapping the renderer.
        vm.prank(admin);
        c.lockRenderer();

        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(admin);
        c.setRenderer(makeAddr("nope"));
    }
}
