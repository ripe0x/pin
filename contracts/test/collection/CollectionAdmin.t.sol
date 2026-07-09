// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";

import {SovereignCollection} from "../../src/collection/SovereignCollection.sol";
import {ISovereignCollection} from "../../src/collection/interfaces/ISovereignCollection.sol";
import {
    CollectionConfig,
    CollectionStatus,
    EdgeType,
    Ref,
    RefKind
} from "../../src/collection/CollectionTypes.sol";

/// @dev Admins: the owner may grant flat, full-access admin keys. An admin can
///      call every management function the owner can EXCEPT managing the admin
///      set (addAdmin/removeAdmin) and transferring ownership, which stay
///      owner-only.
contract CollectionAdminTest is CollectionBase {
    address internal admin = makeAddr("admin");

    bytes internal ownableUnauthAdmin =
        abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", admin);
    bytes internal ownableUnauthStranger =
        abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);

    // ── grant / revoke lifecycle ──────────────────────────────────────────────

    function test_owner_grantsAndRevokesAdmin() public {
        SovereignCollection c = _collection(_freeConfig());
        assertFalse(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISovereignCollection.AdminSet(admin, true);
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISovereignCollection.AdminSet(admin, false);
        vm.prank(artist);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));
    }

    // ── addAdmin guards ───────────────────────────────────────────────────────

    function test_addAdmin_rejectsZeroAccount() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.ZeroAccount.selector);
        vm.prank(artist);
        c.addAdmin(address(0));
    }

    function test_addAdmin_rejectsAlreadyAdmin() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        vm.expectRevert(ISovereignCollection.AlreadyAdmin.selector);
        c.addAdmin(admin);
        vm.stopPrank();
    }

    function test_addAdmin_onlyOwner_notStranger() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ownableUnauthStranger);
        vm.prank(stranger);
        c.addAdmin(stranger);
    }

    // ── removeAdmin guards ────────────────────────────────────────────────────

    function test_removeAdmin_rejectsNotAnAdmin() public {
        SovereignCollection c = _collection(_freeConfig());
        // never granted
        vm.expectRevert(ISovereignCollection.NotAnAdmin.selector);
        vm.prank(artist);
        c.removeAdmin(admin);
    }

    function test_removeAdmin_rejectsDoubleRemove() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.expectRevert(ISovereignCollection.NotAnAdmin.selector);
        c.removeAdmin(admin); // second remove has nothing to revoke
        vm.stopPrank();
    }

    function test_removeAdmin_onlyOwner_notStranger() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ownableUnauthStranger);
        vm.prank(stranger);
        c.removeAdmin(admin);
    }

    // ── admin has full management access ──────────────────────────────────────

    function test_admin_canRunEveryManagementFunction() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.addAdmin(admin);

        // a minted token so setTokenArtwork has a target
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        vm.startPrank(admin);
        c.setClosing(true);
        c.setRenderer(makeAddr("newRenderer"));
        c.setMintHook(makeAddr("hook"));
        c.setPriceStrategy(makeAddr("strategy"));
        c.setMinter(makeAddr("minter"), true);
        c.setTokenArtwork(1, "ipfs://thumb");
        c.setWork(_emptyWork());
        Ref memory ref = Ref(1, address(c), 0, RefKind.Collection);
        c.addEdge(EdgeType.BelongsTo, ref);
        c.setPayoutAddress(makeAddr("payout")); // money routing is in scope for full-access admins
        vm.stopPrank();

        assertTrue(c.isMinter(makeAddr("minter")));
        assertEq(c.tokenArtwork(1), "ipfs://thumb");
    }

    /// @dev Full access is not cosmetic: an admin can actually redirect the
    ///      artist's proceeds. This is the deliberate power of the model, and
    ///      the test documents it so nobody grants an admin key casually.
    function test_admin_setPayoutAddress_redirectsFutureProceeds() public {
        SovereignCollection c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.addAdmin(admin);

        address newPayout = makeAddr("newPayout");
        vm.prank(admin);
        c.setPayoutAddress(newPayout);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);
        assertEq(c.pendingWithdrawal(newPayout), 1 ether);
        assertEq(c.pendingWithdrawal(artist), 0);
    }

    // ── the two owner-only exceptions ─────────────────────────────────────────

    function test_admin_cannotManageAdmins() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // an admin cannot mint peers nor revoke them: the keyring is the
        // owner's alone.
        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.addAdmin(makeAddr("other"));

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.removeAdmin(admin);
    }

    function test_admin_cannotTransferOwnership() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.transferOwnership(admin);
    }

    // ── revocation + non-admins ───────────────────────────────────────────────

    function test_revokedAdmin_losesAccess() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.stopPrank();

        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(admin);
        c.setClosing(true);
    }

    function test_nonAdmin_cannotManage() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.expectRevert(ISovereignCollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setClosing(true);
    }

    function test_owner_remainsAuthorizedAlongsideAdmins() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // owner is an implicit admin and keeps full access
        vm.prank(artist);
        c.setClosing(true);
        (, CollectionStatus status,) = c.config();
        assertEq(uint8(status), uint8(CollectionStatus.Closing));
    }

    // ── freeze still supreme over admins ──────────────────────────────────────

    function test_freeze_blocksAdminArtwork() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);

        vm.prank(artist);
        c.addAdmin(admin);

        // an admin may freeze (full access), and freeze then blocks everyone —
        // including admins — from further artwork writes.
        vm.prank(admin);
        c.freezeMetadata();

        vm.expectRevert(ISovereignCollection.MetadataIsFrozen.selector);
        vm.prank(admin);
        c.setTokenArtwork(1, "ipfs://after-freeze");
    }
}
