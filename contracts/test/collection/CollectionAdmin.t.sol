// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {ICollection} from "../../src/collection/interfaces/ICollection.sol";
import {CollectionConfig, CollectionStatus} from "../../src/collection/CollectionTypes.sol";

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
        Collection c = _collection(_freeConfig());
        assertFalse(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ICollection.AdminSet(admin, true);
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ICollection.AdminSet(admin, false);
        vm.prank(artist);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));
    }

    // ── addAdmin guards ───────────────────────────────────────────────────────

    function test_addAdmin_rejectsZeroAccount() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.ZeroAccount.selector);
        vm.prank(artist);
        c.addAdmin(address(0));
    }

    function test_addAdmin_rejectsAlreadyAdmin() public {
        Collection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        vm.expectRevert(ICollection.AlreadyAdmin.selector);
        c.addAdmin(admin);
        vm.stopPrank();
    }

    function test_addAdmin_onlyOwner_notStranger() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ownableUnauthStranger);
        vm.prank(stranger);
        c.addAdmin(stranger);
    }

    // ── removeAdmin guards ────────────────────────────────────────────────────

    function test_removeAdmin_rejectsNotAnAdmin() public {
        Collection c = _collection(_freeConfig());
        // never granted
        vm.expectRevert(ICollection.NotAnAdmin.selector);
        vm.prank(artist);
        c.removeAdmin(admin);
    }

    function test_removeAdmin_rejectsDoubleRemove() public {
        Collection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.expectRevert(ICollection.NotAnAdmin.selector);
        c.removeAdmin(admin); // second remove has nothing to revoke
        vm.stopPrank();
    }

    function test_removeAdmin_rejectsUnrelatedCaller() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // a caller who is neither the owner nor the account itself is rejected
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.removeAdmin(admin);
    }

    function test_admin_canRenounceSelf() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        // an admin may drop its own key by passing its own address
        vm.expectEmit(true, false, false, true, address(c));
        emit ICollection.AdminSet(admin, false);
        vm.prank(admin);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));

        // and having renounced, it can no longer manage
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(admin);
        c.setMintWindow(0, 0);
    }

    // ── admin has full management access ──────────────────────────────────────

    function test_admin_canRunEveryManagementFunction() public {
        Collection c = _collection(_pricedConfig(1 ether));
        vm.prank(artist);
        c.addAdmin(admin);

        // a minted token so setTokenArtwork has a target
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        c.mint{value: 1 ether}(1);

        vm.startPrank(admin);
        c.setMintWindow(0, 0);
        c.setPrice(0.5 ether);
        c.setRoyalty(250, makeAddr("royalty"));
        c.setSupplyCap(100);
        c.setRenderer(makeAddr("newRenderer"));
        c.setMintHook(makeAddr("hook"));
        c.setPriceStrategy(makeAddr("strategy"));
        c.setMinter(makeAddr("minter"), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        string[] memory cids = new string[](1);
        cids[0] = "ipfs://thumb";
        c.setTokenArtworkBatch(ids, cids);
        c.setWork(_emptyWork());
        c.notifyMetadataUpdate(1, 1);
        c.setPayoutAddress(makeAddr("payout")); // money routing is in scope for full-access admins
        c.lockSupply();
        vm.stopPrank();

        assertTrue(c.isMinter(makeAddr("minter")));
        assertEq(c.tokenArtwork(1), "ipfs://thumb");
        assertTrue(c.isSupplyLocked());
    }

    /// @dev Full access is not cosmetic: an admin can actually redirect the
    ///      artist's proceeds. This is the deliberate power of the model, and
    ///      the test documents it so nobody grants an admin key casually.
    function test_admin_setPayoutAddress_redirectsFutureProceeds() public {
        Collection c = _collection(_pricedConfig(1 ether));
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

    function test_admin_cannotAddOrRemovePeers() public {
        Collection c = _collection(_freeConfig());
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
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(admin);
        c.removeAdmin(admin2);
    }

    function test_admin_cannotTransferOwnership() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.transferOwnership(admin);
    }

    // ── revocation + non-admins ───────────────────────────────────────────────

    function test_revokedAdmin_losesAccess() public {
        Collection c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.stopPrank();

        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(admin);
        c.setMintWindow(0, 0);
    }

    function test_nonAdmin_cannotManage() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(stranger);
        c.setMintWindow(0, 0);
    }

    function test_owner_remainsAuthorizedAlongsideAdmins() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        // owner is an implicit admin and keeps full access
        vm.prank(artist);
        c.setMintWindow(uint64(block.timestamp + 100), 0);
        (, CollectionStatus status,) = c.config();
        assertEq(uint8(status), uint8(CollectionStatus.Scheduled));
    }

    // ── freeze still supreme over admins ──────────────────────────────────────

    function test_freeze_blocksAdminArtwork() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);

        vm.prank(artist);
        c.addAdmin(admin);

        // an admin may freeze (full access), and freeze then blocks everyone —
        // including admins — from further artwork writes.
        vm.prank(admin);
        c.freezeMetadata();

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        string[] memory cids = new string[](1);
        cids[0] = "ipfs://after-freeze";
        vm.expectRevert(ICollection.MetadataIsFrozen.selector);
        vm.prank(admin);
        c.setTokenArtworkBatch(ids, cids);
    }
}
